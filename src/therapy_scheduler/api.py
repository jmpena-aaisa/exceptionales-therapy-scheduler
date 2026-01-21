from __future__ import annotations

import io
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, RootModel

from .auth import (
    AuthError,
    AuthSettings,
    find_user,
    issue_token,
    load_auth_settings,
    parse_bearer_token,
    parse_users_csv,
    verify_password,
    verify_token,
)
from .data_loader import Instance, Patient, PinnedSession, Room, TherapyInfo, Therapist
from .excel_writer import export_excel
from .model import ObjectiveWeights, SchedulerModel, SolverOptions
from .storage import BaseStorage, StorageError, get_storage, session_prefix, validate_id
from .time_utils import DAY_ORDER, availability_to_blocks_per_day, range_to_block


# ---------- Pydantic input/output models ----------


class Availability(RootModel[Dict[str, List[str]]]):
    root: Dict[str, List[str]] = Field(default_factory=dict)

    def to_dict(self) -> Dict[str, List[str]]:
        return self.root


class TherapistPayload(BaseModel):
    id: str
    name: Optional[str] = None
    specialties: List[str] = Field(default_factory=list)
    availability: Optional[Availability] = None


class PinnedSessionPayload(BaseModel):
    day: str
    time: str


class PatientPayload(BaseModel):
    id: str
    name: Optional[str] = None
    therapies: Dict[str, int] = Field(default_factory=dict)
    availability: Optional[Availability] = None
    maxContinuousHours: Optional[int] = None
    noSameDayTherapies: List[str] = Field(default_factory=list)
    fixedTherapists: Dict[str, Dict[str, List[str]]] = Field(default_factory=dict)
    pinnedSessions: Dict[str, List[PinnedSessionPayload]] = Field(default_factory=dict)


class RoomPayload(BaseModel):
    id: str
    name: Optional[str] = None
    therapies: List[str] = Field(default_factory=list)
    capacity: int = 1
    availability: Optional[Availability] = None


class SpecialtyPayload(BaseModel):
    id: str


class TherapyPayload(BaseModel):
    id: str
    requirements: Dict[str, int] = Field(default_factory=dict)
    minPatients: int = 1
    maxPatients: int = 4


class EntitiesPayload(BaseModel):
    therapists: List[TherapistPayload] = Field(default_factory=list)
    patients: List[PatientPayload] = Field(default_factory=list)
    rooms: List[RoomPayload] = Field(default_factory=list)
    specialties: List[SpecialtyPayload] = Field(default_factory=list)
    therapies: List[TherapyPayload] = Field(default_factory=list)


class RunRequest(BaseModel):
    entities: EntitiesPayload
    timeLimit: Optional[float] = None
    patientDaysWeight: Optional[int] = None
    therapistIdleGapWeight: Optional[int] = None


class ScheduleStaff(BaseModel):
    therapistId: str
    specialty: str


class ScheduleSession(BaseModel):
    id: str
    day: str
    start: str
    end: str
    roomId: str
    therapyId: str
    patientIds: List[str]
    staff: List[ScheduleStaff] = Field(default_factory=list)


class ScheduleResponse(BaseModel):
    sessionId: Optional[str] = None
    userId: Optional[str] = None
    status: str
    startedAt: str
    finishedAt: Optional[str]
    objectiveValue: Optional[float]
    diagnostics: List[str] = Field(default_factory=list)
    diagnosticsByMethod: Dict[str, List[str]] = Field(default_factory=dict)
    sessions: List[ScheduleSession] = Field(default_factory=list)


class RunSummary(BaseModel):
    sessionId: str
    userId: str
    status: str
    startedAt: str
    finishedAt: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    userId: str
    email: str
    token: str
    tokenType: str = "Bearer"
    expiresAt: str


# ---------- Converters ----------


def _parse_pinned_sessions(patient: PatientPayload) -> Dict[str, List[PinnedSession]]:
    pinned: Dict[str, List[PinnedSession]] = {}
    for therapy_id, slots in patient.pinnedSessions.items():
        if not isinstance(slots, list):
            continue
        items: List[PinnedSession] = []
        for slot in slots:
            day = str(slot.day).strip()
            time_range = str(slot.time).strip()
            if not day or not time_range:
                continue
            if day not in DAY_ORDER:
                raise ValueError(
                    f"Patient {patient.id} pins '{therapy_id}' on invalid day '{day}'."
                )
            try:
                block = range_to_block(time_range)
            except ValueError as exc:
                raise ValueError(
                    f"Patient {patient.id} pins '{therapy_id}' on invalid time '{time_range}'."
                ) from exc
            items.append(PinnedSession(day=day, block=block))
        if items:
            pinned[therapy_id] = items
    for therapy_id, slots in pinned.items():
        required = patient.therapies.get(therapy_id, 0)
        if required <= 0:
            raise ValueError(
                f"Patient {patient.id} pins sessions for '{therapy_id}' but requires none."
            )
        if len(slots) > required:
            raise ValueError(
                f"Patient {patient.id} pins {len(slots)} '{therapy_id}' sessions but requires {required}."
            )
        seen: set[tuple[str, int]] = set()
        for slot in slots:
            key = (slot.day, slot.block)
            if key in seen:
                raise ValueError(
                    f"Patient {patient.id} repeats pinned '{therapy_id}' on {slot.day} block {slot.block}."
                )
            seen.add(key)
    return pinned


def payload_to_instance(payload: EntitiesPayload) -> Instance:
    specialties = {s.id for s in payload.specialties}
    therapies = {
        t.id: TherapyInfo(
            requirements=t.requirements,
            min_patients=t.minPatients,
            max_patients=t.maxPatients,
        )
        for t in payload.therapies
    }

    therapists = [
        Therapist(
            id=t.id,
            specialties=set(t.specialties),
            availability=availability_to_blocks_per_day(t.availability.to_dict() if t.availability else {}),
        )
        for t in payload.therapists
    ]

    patients = [
        Patient(
            id=p.id,
            therapies=p.therapies,
            availability=availability_to_blocks_per_day(p.availability.to_dict() if p.availability else {}),
            max_continuous_hours=p.maxContinuousHours or 3,
            no_same_day_therapies=set(p.noSameDayTherapies),
            fixed_therapists=p.fixedTherapists,
            pinned_sessions=_parse_pinned_sessions(p),
        )
        for p in payload.patients
    ]

    rooms = [
        Room(
            id=r.id,
            therapies=set(r.therapies),
            capacity=int(r.capacity or 1),
        )
        for r in payload.rooms
    ]

    return Instance(
        therapists=therapists,
        patients=patients,
        rooms=rooms,
        specialties=specialties,
        therapies=therapies,
    )


def solver_status_to_ui(status: str) -> str:
    if status in {"OPTIMAL", "FEASIBLE"}:
        return "success"
    if status in {"INFEASIBLE", "MODEL_INVALID"}:
        return "failed"
    if status == "UNKNOWN":
        return "running"
    return "idle"


def format_sessions(schedule: List[Dict[str, object]]) -> List[ScheduleSession]:
    sessions: List[ScheduleSession] = []
    for item in schedule:
        start, end = str(item["time"]).split("-")
        staff = [
            ScheduleStaff(therapistId=staffer["therapist_id"], specialty=staffer["specialty"])
            for staffer in item.get("staff", [])
        ]
        session = ScheduleSession(
            id=f"{item['room_id']}-{item['therapy_id']}-{item['day']}-{start}",
            day=str(item["day"]),
            start=start,
            end=end,
            roomId=str(item["room_id"]),
            therapyId=str(item["therapy_id"]),
            patientIds=list(item.get("patient_ids", [])),
            staff=staff,
        )
        sessions.append(session)

    sessions.sort(key=lambda s: (s.day, s.start, s.roomId, s.therapyId))
    return sessions


def validate_schedule(schedule: List[Dict[str, object]], instance: Instance) -> None:
    """Guardrail: ensure solver output does not use therapies not available in a room."""
    room_therapies = {room.id: room.therapies for room in instance.rooms}
    invalid = [
        item
        for item in schedule
        if item["therapy_id"] not in room_therapies.get(item["room_id"], set())
    ]
    if invalid:
        details = [
            f"{i['room_id']} missing {i['therapy_id']} ({i['day']} {i['time']})"
            for i in invalid
        ]
        raise ValueError("Schedule uses therapies not allowed in room: " + "; ".join(details))


# ---------- FastAPI app ----------


app = FastAPI(title="Therapy Scheduler API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

storage: BaseStorage = get_storage()
auth_settings: AuthSettings = load_auth_settings()


@dataclass(frozen=True)
class AuthUser:
    user_id: str
    email: Optional[str]


def get_current_user(
    authorization: Optional[str] = Header(default=None),
    x_user_id: Optional[str] = Header(default=None),
) -> AuthUser:
    token = parse_bearer_token(authorization)
    if token:
        if not auth_settings.secret:
            raise HTTPException(status_code=500, detail="Auth secret not configured.")
        try:
            payload = verify_token(token, auth_settings.secret)
        except AuthError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
        user_id = str(payload.get("sub", "")).strip()
        email = str(payload.get("email", "")).strip().lower() or None
        try:
            validate_id(user_id, "user_id")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return AuthUser(user_id=user_id, email=email)

    if auth_settings.require_auth:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token.")

    if x_user_id:
        x_user_id = x_user_id.strip()
        try:
            validate_id(x_user_id, "user_id")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return AuthUser(user_id=x_user_id, email=None)

    return AuthUser(user_id="anonymous", email=None)


def resolve_session_root(user_id: str, session_id: str) -> str:
    try:
        return session_prefix(user_id, session_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def resolve_entities_key(user_id: str) -> str:
    try:
        validate_id(user_id, "user_id")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return f"users/{user_id}/entities.json"


def list_run_summaries(user_id: str) -> List[RunSummary]:
    prefix = f"sessions/{user_id}"
    try:
        keys = storage.list_prefix(prefix)
    except StorageError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    meta_keys = [key for key in keys if key.endswith("/meta.json")]
    runs: List[RunSummary] = []
    for key in meta_keys:
        try:
            payload = storage.read_json(key)
            runs.append(RunSummary.model_validate(payload))
        except Exception:
            continue
    runs.sort(key=lambda item: item.finishedAt or item.startedAt or "", reverse=True)
    return runs


@app.post("/api/run", response_model=ScheduleResponse)
def run_solver_endpoint(req: RunRequest, user: AuthUser = Depends(get_current_user)) -> ScheduleResponse:
    session_id = uuid.uuid4().hex
    session_root = resolve_session_root(user.user_id, session_id)
    request_key = f"{session_root}/request.json"
    schedule_key = f"{session_root}/schedule.json"
    excel_key = f"{session_root}/schedule.xlsx"
    meta_key = f"{session_root}/meta.json"
    latest_key = f"sessions/{user.user_id}/latest.json"

    started_at = datetime.utcnow().isoformat()

    try:
        storage.write_json(request_key, req.model_dump())
    except StorageError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        instance = payload_to_instance(req.entities)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    objective_weights = ObjectiveWeights(
        patient_days_weight=req.patientDaysWeight or 1,
        therapist_idle_gap_weight=req.therapistIdleGapWeight or 1,
    )
    solver_options = SolverOptions(
        time_limit=req.timeLimit or 30.0,
        log_search_progress=False,
    )

    scheduler = SchedulerModel(
        instance=instance,
        objective_weights=objective_weights,
        solver_options=solver_options,
    )
    result = scheduler.solve()
    try:
        validate_schedule(result.schedule, instance)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    sessions = format_sessions(result.schedule)
    finished_at = datetime.utcnow().isoformat()
    status_ui = solver_status_to_ui(result.status)

    schedule_payload = {
        "sessionId": session_id,
        "userId": user.user_id,
        "status": status_ui,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "objectiveValue": result.objective_value,
        "diagnostics": result.diagnostics,
        "diagnosticsByMethod": result.diagnostics_by_method,
        "sessions": [s.dict() for s in sessions],
    }

    meta_payload = {
        "sessionId": session_id,
        "userId": user.user_id,
        "status": status_ui,
        "startedAt": started_at,
        "finishedAt": finished_at,
    }

    try:
        storage.write_json(schedule_key, schedule_payload)
        storage.write_json(meta_key, meta_payload)
        storage.write_json(latest_key, {"sessionId": session_id, "updatedAt": finished_at})
        with tempfile.TemporaryDirectory() as tmpdir:
            excel_path = Path(tmpdir) / "schedule.xlsx"
            export_excel(result.schedule, excel_path)
            storage.write_bytes(
                excel_key,
                excel_path.read_bytes(),
                content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
    except (StorageError, OSError) as exc:
        raise HTTPException(status_code=500, detail=f"Failed to persist schedule: {exc}") from exc

    return ScheduleResponse(**schedule_payload)


@app.get("/api/entities", response_model=EntitiesPayload)
def get_entities(user: AuthUser = Depends(get_current_user)) -> EntitiesPayload:
    key = resolve_entities_key(user.user_id)
    if not storage.exists(key):
        return EntitiesPayload()
    try:
        payload = storage.read_json(key)
        return EntitiesPayload.model_validate(payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Invalid entities payload: {exc}") from exc


@app.put("/api/entities", response_model=EntitiesPayload)
def put_entities(payload: EntitiesPayload, user: AuthUser = Depends(get_current_user)) -> EntitiesPayload:
    key = resolve_entities_key(user.user_id)
    try:
        storage.write_json(key, payload.model_dump())
    except StorageError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return payload


@app.get("/api/results", response_model=ScheduleResponse)
def get_results(
    session_id: Optional[str] = Query(default=None, alias="sessionId"),
    user: AuthUser = Depends(get_current_user),
) -> ScheduleResponse:
    if not session_id:
        latest_key = f"sessions/{user.user_id}/latest.json"
        if not storage.exists(latest_key):
            raise HTTPException(status_code=404, detail="No schedule found.")
        latest = storage.read_json(latest_key)
        session_id = str(latest.get("sessionId", "")).strip()
    if not session_id:
        raise HTTPException(status_code=404, detail="No schedule found.")

    session_root = resolve_session_root(user.user_id, session_id)
    schedule_key = f"{session_root}/schedule.json"
    if not storage.exists(schedule_key):
        raise HTTPException(status_code=404, detail="Schedule not found.")
    payload = storage.read_json(schedule_key)
    try:
        return ScheduleResponse(**payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Invalid schedule file: {exc}") from exc


@app.get("/api/runs", response_model=List[RunSummary])
def list_runs(
    limit: int = Query(default=20, ge=1, le=100),
    user: AuthUser = Depends(get_current_user),
) -> List[RunSummary]:
    runs = list_run_summaries(user.user_id)
    return runs[:limit]


@app.delete("/api/runs/{session_id}", status_code=status.HTTP_200_OK)
def delete_run(session_id: str, user: AuthUser = Depends(get_current_user)) -> Dict[str, bool]:
    session_root = resolve_session_root(user.user_id, session_id)
    try:
        keys = storage.list_prefix(session_root)
    except StorageError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if not keys:
        raise HTTPException(status_code=404, detail="Run not found.")
    for key in keys:
        try:
            storage.delete(key)
        except StorageError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    latest_key = f"sessions/{user.user_id}/latest.json"
    if storage.exists(latest_key):
        try:
            latest = storage.read_json(latest_key)
        except Exception:
            latest = None
        latest_id = str(latest.get("sessionId", "")).strip() if isinstance(latest, dict) else ""
        if latest_id == session_id:
            runs = list_run_summaries(user.user_id)
            if runs:
                updated_at = runs[0].finishedAt or runs[0].startedAt
                try:
                    storage.write_json(latest_key, {"sessionId": runs[0].sessionId, "updatedAt": updated_at})
                except StorageError as exc:
                    raise HTTPException(status_code=500, detail=str(exc)) from exc
            else:
                try:
                    storage.delete(latest_key)
                except StorageError as exc:
                    raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"deleted": True}


@app.get("/api/download/excel")
def download_excel(
    session_id: Optional[str] = Query(default=None, alias="sessionId"),
    user: AuthUser = Depends(get_current_user),
) -> StreamingResponse:
    if not session_id:
        latest_key = f"sessions/{user.user_id}/latest.json"
        if not storage.exists(latest_key):
            raise HTTPException(status_code=404, detail="No schedule found.")
        latest = storage.read_json(latest_key)
        session_id = str(latest.get("sessionId", "")).strip()
    if not session_id:
        raise HTTPException(status_code=404, detail="No schedule found.")

    session_root = resolve_session_root(user.user_id, session_id)
    excel_key = f"{session_root}/schedule.xlsx"
    if not storage.exists(excel_key):
        raise HTTPException(status_code=404, detail="Excel not generated yet.")

    payload = storage.read_bytes(excel_key)
    headers = {"Content-Disposition": "attachment; filename=schedule.xlsx"}
    return StreamingResponse(
        io.BytesIO(payload),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.post("/api/login", response_model=LoginResponse)
def login_endpoint(req: LoginRequest) -> LoginResponse:
    if not auth_settings.secret:
        raise HTTPException(status_code=500, detail="Auth secret not configured.")
    try:
        users_text = storage.read_text(auth_settings.users_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load users: {exc}") from exc

    users = parse_users_csv(users_text)
    user = find_user(users, req.email)
    if not user or user.disabled or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials.")
    try:
        validate_id(user.user_id, "user_id")
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"Invalid user_id in users.csv: {exc}") from exc

    token, exp = issue_token(user.user_id, user.email, auth_settings.secret, auth_settings.token_ttl_seconds)
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat()
    return LoginResponse(
        userId=user.user_id,
        email=user.email,
        token=token,
        expiresAt=expires_at,
    )
