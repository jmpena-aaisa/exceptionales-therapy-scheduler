from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, RootModel

from .data_loader import Instance, Patient, Room, SpecialtyInfo, Therapist
from .excel_writer import export_excel
from .model import ObjectiveWeights, SchedulerModel, SolverOptions
from .time_utils import availability_to_blocks_per_day, block_to_range, range_to_block


# ---------- Pydantic input/output models ----------


class Availability(RootModel[Dict[str, List[str]]]):
    root: Dict[str, List[str]] = Field(default_factory=dict)

    def to_dict(self) -> Dict[str, List[str]]:
        return self.root


class TherapistPayload(BaseModel):
    id: str
    specialties: List[str] = Field(default_factory=list)
    availability: Optional[Availability] = None


class PatientPayload(BaseModel):
    id: str
    requirements: Dict[str, int] = Field(default_factory=dict)
    availability: Optional[Availability] = None
    maxContinuousHours: Optional[int] = None
    noSameDaySpecialties: List[str] = Field(default_factory=list)


class RoomPayload(BaseModel):
    id: str
    specialties: List[str] = Field(default_factory=list)
    capacity: int = 1
    availability: Optional[Availability] = None


class SpecialtyPayload(BaseModel):
    id: str
    minQuorum: int = 1
    maxQuorum: int = 4


class EntitiesPayload(BaseModel):
    therapists: List[TherapistPayload] = Field(default_factory=list)
    patients: List[PatientPayload] = Field(default_factory=list)
    rooms: List[RoomPayload] = Field(default_factory=list)
    specialties: List[SpecialtyPayload] = Field(default_factory=list)


class RunRequest(BaseModel):
    entities: EntitiesPayload
    timeLimit: Optional[float] = None
    patientDaysWeight: Optional[int] = None
    therapistIdleGapWeight: Optional[int] = None


class ScheduleSession(BaseModel):
    id: str
    day: str
    start: str
    end: str
    roomId: str
    therapistId: str
    patientIds: List[str]
    specialty: str


class ScheduleResponse(BaseModel):
    status: str
    startedAt: str
    finishedAt: Optional[str]
    objectiveValue: Optional[float]
    diagnostics: List[str] = Field(default_factory=list)
    sessions: List[ScheduleSession] = Field(default_factory=list)


# ---------- Converters ----------


def payload_to_instance(payload: EntitiesPayload) -> Instance:
    specialties = {
        s.id: SpecialtyInfo(min_quorum=s.minQuorum, max_quorum=s.maxQuorum)
        for s in payload.specialties
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
            requirements=p.requirements,
            availability=availability_to_blocks_per_day(p.availability.to_dict() if p.availability else {}),
            max_continuous_hours=p.maxContinuousHours or 3,
            no_same_day_specialties=set(p.noSameDaySpecialties),
        )
        for p in payload.patients
    ]

    rooms = [
        Room(
            id=r.id,
            specialties=set(r.specialties),
            capacity=int(r.capacity or 1),
        )
        for r in payload.rooms
    ]

    return Instance(
        therapists=therapists,
        patients=patients,
        rooms=rooms,
        specialties=specialties,
    )


def solver_status_to_ui(status: str) -> str:
    if status in {"OPTIMAL", "FEASIBLE"}:
        return "success"
    if status in {"INFEASIBLE", "MODEL_INVALID"}:
        return "failed"
    if status == "UNKNOWN":
        return "running"
    return "idle"


def aggregate_sessions(schedule: List[Dict[str, str]]) -> List[ScheduleSession]:
    grouped: Dict[tuple, List[str]] = {}
    metadata: Dict[tuple, Dict[str, str]] = {}

    for item in schedule:
        start, end = item["time"].split("-")
        key = (
            item["day"],
            start,
            end,
            item["room_id"],
            item["therapist_id"],
            item["specialty"],
        )
        if key not in grouped:
            grouped[key] = []
            metadata[key] = {
                "day": item["day"],
                "start": start,
                "end": end,
                "roomId": item["room_id"],
                "therapistId": item["therapist_id"],
                "specialty": item["specialty"],
            }
        grouped[key].append(item["patient_id"])

    sessions: List[ScheduleSession] = []
    for key, patients in grouped.items():
        info = metadata[key]
        sessions.append(
            ScheduleSession(
                id=f"{info['roomId']}-{info['therapistId']}-{info['day']}-{info['start']}",
                patientIds=sorted(patients),
                **info,
            )
        )

    sessions.sort(key=lambda s: (s.day, s.start, s.roomId, s.therapistId))
    return sessions


def validate_schedule(schedule: List[Dict[str, str]], instance: Instance) -> None:
    """Guardrail: ensure solver output does not use specialties not available in a room."""
    room_specialties = {room.id: room.specialties for room in instance.rooms}
    invalid = [
        item
        for item in schedule
        if item["specialty"] not in room_specialties.get(item["room_id"], set())
    ]
    if invalid:
        details = [
          f"{i['room_id']} missing {i['specialty']} ({i['day']} {i['time']})"
          for i in invalid
        ]
        raise ValueError("Schedule uses specialties not allowed in room: " + "; ".join(details))


# ---------- FastAPI app ----------


app = FastAPI(title="Therapy Scheduler API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OUTPUT_JSON = Path("output/schedule.json")
OUTPUT_EXCEL = Path("output/schedule.xlsx")
DEBUG_REQUEST = Path("output/last_request.json")


@app.post("/api/run", response_model=ScheduleResponse)
def run_solver_endpoint(req: RunRequest) -> ScheduleResponse:
    started_at = datetime.utcnow().isoformat()

    # Persist incoming payload for debugging and parity checks with the solver.
    DEBUG_REQUEST.parent.mkdir(parents=True, exist_ok=True)
    DEBUG_REQUEST.write_text(json.dumps(req.model_dump(), indent=2))

    instance = payload_to_instance(req.entities)

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

    sessions = aggregate_sessions(result.schedule)
    finished_at = datetime.utcnow().isoformat()
    status_ui = solver_status_to_ui(result.status)

    schedule_payload = {
        "status": status_ui,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "objectiveValue": result.objective_value,
        "diagnostics": result.diagnostics,
        "sessions": [s.dict() for s in sessions],
    }

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON.write_text(json.dumps(schedule_payload, indent=2))
    export_excel(result.schedule, OUTPUT_EXCEL)

    return ScheduleResponse(**schedule_payload)


@app.get("/api/results", response_model=ScheduleResponse)
def get_results() -> ScheduleResponse:
    if not OUTPUT_JSON.exists():
        raise HTTPException(status_code=404, detail="No schedule found.")
    payload = json.loads(OUTPUT_JSON.read_text())
    try:
        return ScheduleResponse(**payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Invalid schedule file: {exc}") from exc


@app.get("/api/download/excel")
def download_excel() -> FileResponse:
    if not OUTPUT_EXCEL.exists():
        raise HTTPException(status_code=404, detail="Excel not generated yet.")
    return FileResponse(path=OUTPUT_EXCEL, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename="schedule.xlsx")
