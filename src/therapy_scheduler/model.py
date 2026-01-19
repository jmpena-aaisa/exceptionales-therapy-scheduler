from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Set, Tuple

from ortools.sat.python import cp_model

from .data_loader import Instance, Patient, Room, TherapyInfo, Therapist
from .time_utils import BLOCKS, DAY_ORDER, block_to_range, consecutive_segments


PatientSessionKey = Tuple[str, str, str, str, int]
SessionKey = Tuple[str, str, str, int]
StaffingKey = Tuple[str, str, str, str, int, str]


@dataclass
class ObjectiveWeights:
    patient_days_weight: int = 1
    therapist_idle_gap_weight: int = 1


@dataclass
class SolverOptions:
    time_limit: float = 30.0
    log_search_progress: bool = False


@dataclass
class SolveResult:
    status: str
    objective_value: float
    schedule: List[Dict[str, object]]
    diagnostics: List[str]
    diagnostics_by_method: Dict[str, List[str]]


def build_base_variables(
    model: cp_model.CpModel,
    instance: Instance,
) -> Tuple[
    Dict[SessionKey, cp_model.IntVar],
    Dict[PatientSessionKey, cp_model.IntVar],
    Dict[StaffingKey, cp_model.IntVar],
]:
    session_active: Dict[SessionKey, cp_model.IntVar] = {}
    patient_sessions: Dict[PatientSessionKey, cp_model.IntVar] = {}
    staffing: Dict[StaffingKey, cp_model.IntVar] = {}

    def get_session_var(therapy_id: str, room_id: str, day: str, block: int) -> cp_model.IntVar:
        key = (therapy_id, room_id, day, block)
        if key not in session_active:
            session_active[key] = model.NewBoolVar(f"s_{therapy_id}_{room_id}_{day}_{block}")
        return session_active[key]

    for therapy_id, therapy in instance.therapies.items():
        for room in instance.rooms:
            if therapy_id not in room.therapies:
                continue
            for day in DAY_ORDER:
                for block in BLOCKS:
                    session_var = get_session_var(therapy_id, room.id, day, block)
                    for specialty in therapy.requirements.keys():
                        for therapist in instance.therapists:
                            if specialty not in therapist.specialties:
                                continue
                            if (
                                day not in therapist.availability
                                or block not in therapist.availability[day]
                            ):
                                continue
                            staff_key = (
                                therapist.id,
                                therapy_id,
                                room.id,
                                day,
                                block,
                                specialty,
                            )
                            if staff_key in staffing:
                                continue
                            staff_var = model.NewBoolVar(
                                f"t_{therapist.id}_{therapy_id}_{room.id}_{day}_{block}_{specialty}"
                            )
                            staffing[staff_key] = staff_var
                            model.Add(staff_var <= session_var)

    for patient in instance.patients:
        pinned_by_therapy: Dict[str, Dict[str, Set[int]]] = {}
        for therapy_id, slots in patient.pinned_sessions.items():
            for slot in slots:
                pinned_by_therapy.setdefault(therapy_id, {}).setdefault(
                    slot.day, set()
                ).add(slot.block)
        for therapy_id, required in patient.therapies.items():
            if required <= 0:
                continue
            for day in DAY_ORDER:
                blocks = set(patient.availability.get(day, set()))
                blocks.update(pinned_by_therapy.get(therapy_id, {}).get(day, set()))
                if not blocks:
                    continue
                for block in blocks:
                    for room in instance.rooms:
                        if therapy_id not in room.therapies:
                            continue
                        session_var = get_session_var(therapy_id, room.id, day, block)
                        var_name = f"x_{patient.id}_{therapy_id}_{room.id}_{day}_{block}"
                        assign_var = model.NewBoolVar(var_name)
                        patient_sessions[
                            (patient.id, therapy_id, room.id, day, block)
                        ] = assign_var
                        model.Add(assign_var <= session_var)

    return session_active, patient_sessions, staffing


class SchedulerModel:
    def __init__(
        self,
        instance: Instance,
        objective_weights: ObjectiveWeights,
        solver_options: SolverOptions,
    ):
        self.instance = instance
        self.objective_weights = objective_weights
        self.solver_options = solver_options
        self.model = cp_model.CpModel()
        self.diagnostic_mode: Optional[str] = None
        # patient_sessions[(patient, therapy, room, day, block)] == 1 if patient attends that therapy session.
        self.patient_sessions: Dict[PatientSessionKey, cp_model.IntVar] = {}
        # session_active[(therapy, room, day, block)] == 1 if the therapy session is opened.
        self.session_active: Dict[SessionKey, cp_model.IntVar] = {}
        # staffing[(therapist, therapy, room, day, block, specialty)] == 1 if therapist staffs that role.
        self.staffing: Dict[StaffingKey, cp_model.IntVar] = {}
        # patient_day_used[(patient, day)] == 1 if the patient has any session that day (feeds objective).
        self.patient_day_used: Dict[Tuple[str, str], cp_model.IntVar] = {}
        # therapist_busy[(therapist, day, block)] == 1 if therapist works that block (used to spot idle gaps).
        self.therapist_busy: Dict[Tuple[str, str, int], cp_model.IntVar] = {}
        # idle_gaps collects variables marking single-block idle gaps surrounded by work.
        self.idle_gaps: List[cp_model.IntVar] = []
        # Assumptions for infeasibility explanations (diagnostic mode).
        self.assumptions: Dict[str, cp_model.IntVar] = {}
        self.assumption_index_to_label: Dict[int, str] = {}
        # Soft constraint slacks (diagnostic mode).
        self.slack_patient_requirements: Dict[Tuple[str, str], cp_model.IntVar] = {}
        self.slack_no_same_day: Dict[Tuple[str, str, str], cp_model.IntVar] = {}
        self.slack_staffing: Dict[Tuple[str, str, str, int, str], cp_model.IntVar] = {}
        self.slack_session_min: Dict[SessionKey, cp_model.IntVar] = {}
        self.slack_session_max: Dict[SessionKey, cp_model.IntVar] = {}
        self.slack_fixed_therapist: Dict[
            Tuple[str, str, str, str], List[cp_model.IntVar]
        ] = {}

    def solve(self) -> SolveResult:
        self.diagnostic_mode = None
        self._build_variables()
        self._add_constraints()
        self._add_objective()

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.solver_options.time_limit
        solver.parameters.log_search_progress = self.solver_options.log_search_progress

        status_code = solver.Solve(self.model)
        status_name = self._status_name(status_code)

        schedule: List[Dict[str, object]] = []
        diagnostics: List[str] = []
        diagnostics_by_method: Dict[str, List[str]] = {}
        if status_code in (cp_model.FEASIBLE, cp_model.OPTIMAL):
            for (therapy_id, room_id, day, block), session_var in self.session_active.items():
                if solver.Value(session_var) != 1:
                    continue
                patient_ids = [
                    pid
                    for (pid, tid, rid, d, b), var in self.patient_sessions.items()
                    if tid == therapy_id and rid == room_id and d == day and b == block and solver.Value(var) == 1
                ]
                staff = [
                    {"therapist_id": therapist_id, "specialty": specialty}
                    for (
                        therapist_id,
                        tid,
                        rid,
                        d,
                        b,
                        specialty,
                    ), var in self.staffing.items()
                    if tid == therapy_id
                    and rid == room_id
                    and d == day
                    and b == block
                    and solver.Value(var) == 1
                ]
                schedule.append(
                    {
                        "therapy_id": therapy_id,
                        "room_id": room_id,
                        "day": day,
                        "time": block_to_range(block),
                        "patient_ids": sorted(patient_ids),
                        "staff": sorted(
                            staff,
                            key=lambda item: (item["specialty"], item["therapist_id"]),
                        ),
                    }
                )
            schedule.sort(
                key=lambda item: (
                    DAY_ORDER.index(str(item["day"])),
                    str(item["time"]),
                    str(item["room_id"]),
                    str(item["therapy_id"]),
                )
            )
        elif status_code in (
            cp_model.INFEASIBLE,
            cp_model.UNKNOWN,
            cp_model.MODEL_INVALID,
        ):
            diagnostics_by_method = self._run_diagnostics()
            diagnostics = self._flatten_diagnostics(diagnostics_by_method)

        return SolveResult(
            status=status_name,
            objective_value=solver.ObjectiveValue(),
            schedule=schedule,
            diagnostics=diagnostics,
            diagnostics_by_method=diagnostics_by_method,
        )

    def _get_session_var(self, therapy_id: str, room_id: str, day: str, block: int) -> cp_model.IntVar:
        key = (therapy_id, room_id, day, block)
        if key not in self.session_active:
            self.session_active[key] = self.model.NewBoolVar(
                f"s_{therapy_id}_{room_id}_{day}_{block}"
            )
        return self.session_active[key]

    def _build_variables(self) -> None:
        """Create assignment and session variables for feasible combinations."""
        (
            self.session_active,
            self.patient_sessions,
            self.staffing,
        ) = build_base_variables(self.model, self.instance)
        self._ensure_feasibility_of_requirements()

    def _ensure_feasibility_of_requirements(self) -> None:
        # No early hard failure: let diagnostics report infeasibility details.
        return

    def _add_constraints(self) -> None:
        self._session_capacity_constraints()
        self._staffing_requirements()
        self._patient_requirements()
        self._patient_pinned_sessions()
        self._patient_fixed_therapists()
        self._patient_no_same_day_therapies()
        self._one_session_per_time()
        self._patient_continuous_hours_limit()
        self._therapist_and_room_single_session()
        if self.diagnostic_mode is None:
            self._build_therapist_busy_indicators()
            self._therapist_idle_gaps()
            self._patient_day_indicators()

    def _session_capacity_constraints(self) -> None:
        # Enforce session min/max patients, capped by room capacity.
        rooms_by_id = {room.id: room for room in self.instance.rooms}
        for (
            therapy_id,
            room_id,
            day,
            block,
        ), session_var in self.session_active.items():
            session_assignments = [
                var
                for (pid, tid, rid, d, b), var in self.patient_sessions.items()
                if tid == therapy_id and rid == room_id and d == day and b == block
            ]
            total_patients = sum(session_assignments)
            therapy_info: TherapyInfo = self.instance.therapies[therapy_id]
            room: Room = rooms_by_id[room_id]
            max_allowed = min(therapy_info.max_patients, room.capacity)
            if self.diagnostic_mode == "soft":
                slack_max = self.model.NewIntVar(
                    0,
                    max_allowed,
                    f"slack_max_{therapy_id}_{room_id}_{day}_{block}",
                )
                slack_min = self.model.NewIntVar(
                    0,
                    therapy_info.min_patients,
                    f"slack_min_{therapy_id}_{room_id}_{day}_{block}",
                )
                self.slack_session_max[(therapy_id, room_id, day, block)] = slack_max
                self.slack_session_min[(therapy_id, room_id, day, block)] = slack_min
                self.model.Add(total_patients <= max_allowed + slack_max)
                self.model.Add(total_patients + slack_min >= therapy_info.min_patients * session_var)
            else:
                assumption = self._assumption_for(
                    f"session_capacity|{therapy_id}"
                )
                constraint = self.model.Add(total_patients <= max_allowed)
                if assumption is not None:
                    constraint.OnlyEnforceIf(assumption)
                constraint = self.model.Add(
                    total_patients >= therapy_info.min_patients * session_var
                )
                if assumption is not None:
                    constraint.OnlyEnforceIf(assumption)

    def _staffing_requirements(self) -> None:
        # Enforce required number of therapists per specialty for each session.
        for (
            therapy_id,
            room_id,
            day,
            block,
        ), session_var in self.session_active.items():
            therapy_info = self.instance.therapies[therapy_id]
            for specialty, required in therapy_info.requirements.items():
                staff_vars = [
                    var
                    for (
                        _tid,
                        tid,
                        rid,
                        d,
                        b,
                        spec,
                    ), var in self.staffing.items()
                    if tid == therapy_id
                    and rid == room_id
                    and d == day
                    and b == block
                    and spec == specialty
                ]
                if self.diagnostic_mode == "soft":
                    slack = self.model.NewIntVar(
                        0,
                        required,
                        f"slack_staff_{therapy_id}_{room_id}_{day}_{block}_{specialty}",
                    )
                    self.slack_staffing[
                        (therapy_id, room_id, day, block, specialty)
                    ] = slack
                    if staff_vars:
                        self.model.Add(sum(staff_vars) + slack >= required * session_var)
                    else:
                        if required > 0:
                            self.model.Add(slack >= required * session_var)
                else:
                    assumption = self._assumption_for(
                        f"staffing|{therapy_id}|{specialty}"
                    )
                    if staff_vars:
                        constraint = self.model.Add(sum(staff_vars) == required * session_var)
                        if assumption is not None:
                            constraint.OnlyEnforceIf(assumption)
                    else:
                        if required > 0:
                            constraint = self.model.Add(session_var == 0)
                            if assumption is not None:
                                constraint.OnlyEnforceIf(assumption)

    def _patient_requirements(self) -> None:
        # Exactly meet the required count of sessions per patient and therapy.
        for patient in self.instance.patients:
            for therapy_id, required in patient.therapies.items():
                vars_for_requirement = [
                    var
                    for (
                        pid,
                        tid,
                        _rid,
                        _day,
                        _block,
                    ), var in self.patient_sessions.items()
                    if pid == patient.id and tid == therapy_id
                ]
                if required >= 0:
                    if self.diagnostic_mode == "soft":
                        slack = self.model.NewIntVar(
                            0,
                            required,
                            f"slack_req_{patient.id}_{therapy_id}",
                        )
                        self.slack_patient_requirements[(patient.id, therapy_id)] = slack
                        self.model.Add(sum(vars_for_requirement) + slack == required)
                    else:
                        assumption = self._assumption_for(
                            f"patient_requirement|{patient.id}|{therapy_id}"
                        )
                        constraint = self.model.Add(sum(vars_for_requirement) == required)
                        if assumption is not None:
                            constraint.OnlyEnforceIf(assumption)

    def _patient_pinned_sessions(self) -> None:
        # Ensure pinned therapy sessions are scheduled at the requested time.
        for patient in self.instance.patients:
            if not patient.pinned_sessions:
                continue
            for therapy_id, slots in patient.pinned_sessions.items():
                for slot in slots:
                    vars_for_slot = [
                        var
                        for (
                            pid,
                            tid,
                            _rid,
                            day,
                            block,
                        ), var in self.patient_sessions.items()
                        if pid == patient.id
                        and tid == therapy_id
                        and day == slot.day
                        and block == slot.block
                    ]
                    assumption = self._assumption_for(
                        f"pinned_session|{patient.id}|{therapy_id}|{slot.day}|{slot.block}"
                    )
                    constraint = self.model.Add(sum(vars_for_slot) == 1)
                    if assumption is not None:
                        constraint.OnlyEnforceIf(assumption)

    def _patient_fixed_therapists(self) -> None:
        # Ensure fixed therapists staff sessions a patient attends.
        for patient in self.instance.patients:
            if not patient.fixed_therapists:
                continue
            for therapy_id, fixed in patient.fixed_therapists.items():
                if not fixed:
                    continue
                for specialty, therapist_id in fixed.items():
                    therapist_ids = therapist_id if isinstance(therapist_id, list) else [therapist_id]
                    therapist_ids = [tid for tid in therapist_ids if tid]
                    if not therapist_ids:
                        continue
                    for therapist_id in therapist_ids:
                        for (
                            pid,
                            tid,
                            rid,
                            day,
                            block,
                        ), assign_var in self.patient_sessions.items():
                            if pid != patient.id or tid != therapy_id:
                                continue
                            staff_key = (
                                therapist_id,
                                therapy_id,
                                rid,
                                day,
                                block,
                                specialty,
                            )
                            staff_var = self.staffing.get(staff_key)
                            if self.diagnostic_mode == "soft":
                                slack = self.model.NewBoolVar(
                                    f"slack_fixed_{patient.id}_{therapy_id}_{specialty}_{therapist_id}_{rid}_{day}_{block}"
                                )
                                self.slack_fixed_therapist.setdefault(
                                    (patient.id, therapy_id, specialty, therapist_id), []
                                ).append(slack)
                                if staff_var is not None:
                                    self.model.Add(assign_var <= staff_var + slack)
                                else:
                                    self.model.Add(assign_var <= slack)
                                continue
                            assumption = self._assumption_for(
                                f"fixed_therapist|{patient.id}|{therapy_id}|{specialty}|{therapist_id}"
                            )
                            if staff_var is not None:
                                constraint = self.model.Add(assign_var <= staff_var)
                            else:
                                constraint = self.model.Add(assign_var == 0)
                            if assumption is not None:
                                constraint.OnlyEnforceIf(assumption)

    def _patient_no_same_day_therapies(self) -> None:
        # Optional rule: at most one session of a therapy for a patient per day.
        for patient in self.instance.patients:
            for therapy_id in patient.no_same_day_therapies:
                for day in DAY_ORDER:
                    vars_for_day = [
                        var
                        for (
                            pid,
                            tid,
                            _rid,
                            d,
                            _block,
                        ), var in self.patient_sessions.items()
                        if pid == patient.id and d == day and tid == therapy_id
                    ]
                    if vars_for_day:
                        if self.diagnostic_mode == "soft":
                            slack = self.model.NewIntVar(
                                0,
                                len(vars_for_day),
                                f"slack_nosameday_{patient.id}_{therapy_id}_{day}",
                            )
                            self.slack_no_same_day[(patient.id, therapy_id, day)] = slack
                            self.model.Add(sum(vars_for_day) <= 1 + slack)
                        else:
                            assumption = self._assumption_for(
                                f"no_same_day|{patient.id}|{therapy_id}"
                            )
                            constraint = self.model.Add(sum(vars_for_day) <= 1)
                            if assumption is not None:
                                constraint.OnlyEnforceIf(assumption)

    def _one_session_per_time(self) -> None:
        # Patients: at most one session per time slot.
        for patient in self.instance.patients:
            for day in DAY_ORDER:
                for block in BLOCKS:
                    overlapping = [
                        var
                        for (pid, _tid, _rid, d, b), var in self.patient_sessions.items()
                        if pid == patient.id and d == day and b == block
                    ]
                    if overlapping:
                        assumption = self._assumption_for(
                            f"patient_one_session|{patient.id}"
                        )
                        constraint = self.model.Add(sum(overlapping) <= 1)
                        if assumption is not None:
                            constraint.OnlyEnforceIf(assumption)

    def _patient_continuous_hours_limit(self) -> None:
        # Sliding window: prevent more than max_continuous_hours consecutive blocks per day.
        segments = consecutive_segments()
        for patient in self.instance.patients:
            limit = patient.max_continuous_hours
            for day in DAY_ORDER:
                for segment in segments:
                    if len(segment) < 4:
                        continue
                    for idx in range(len(segment) - 3):
                        window_blocks = segment[idx : idx + 4]
                        window_vars = [
                            var
                            for (
                                pid,
                                _tid,
                                _rid,
                                d,
                                b,
                            ), var in self.patient_sessions.items()
                            if pid == patient.id and d == day and b in window_blocks
                        ]
                        if window_vars:
                            assumption = self._assumption_for(
                                f"patient_continuous|{patient.id}"
                            )
                            constraint = self.model.Add(sum(window_vars) <= limit)
                            if assumption is not None:
                                constraint.OnlyEnforceIf(assumption)

    def _therapist_and_room_single_session(self) -> None:
        # Only one session per therapist per block.
        for therapist in self.instance.therapists:
            for day in DAY_ORDER:
                for block in BLOCKS:
                    sessions = [
                        session_var
                        for (
                            tid,
                            _therapy_id,
                            _rid,
                            d,
                            b,
                            _spec,
                        ), session_var in self.staffing.items()
                        if tid == therapist.id and d == day and b == block
                    ]
                    if sessions:
                        assumption = self._assumption_for(
                            f"therapist_one_session|{therapist.id}"
                        )
                        constraint = self.model.Add(sum(sessions) <= 1)
                        if assumption is not None:
                            constraint.OnlyEnforceIf(assumption)

        # Only one session per room per block.
        for room in self.instance.rooms:
            for day in DAY_ORDER:
                for block in BLOCKS:
                    sessions = [
                        session_var
                        for (
                            _therapy_id,
                            rid,
                            d,
                            b,
                        ), session_var in self.session_active.items()
                        if rid == room.id and d == day and b == block
                    ]
                    if sessions:
                        assumption = self._assumption_for(f"room_one_session|{room.id}")
                        constraint = self.model.Add(sum(sessions) <= 1)
                        if assumption is not None:
                            constraint.OnlyEnforceIf(assumption)

    def _build_therapist_busy_indicators(self) -> None:
        # Derive per-block busy indicators so we can reason about gaps/contiguity.
        for therapist in self.instance.therapists:
            for day in DAY_ORDER:
                for block in BLOCKS:
                    sessions = [
                        session_var
                        for (
                            tid,
                            _therapy_id,
                            _rid,
                            d,
                            b,
                            _spec,
                        ), session_var in self.staffing.items()
                        if tid == therapist.id and d == day and b == block
                    ]
                    if not sessions:
                        continue
                    indicator = self.model.NewBoolVar(
                        f"busy_{therapist.id}_{day}_{block}"
                    )
                    self.therapist_busy[(therapist.id, day, block)] = indicator
                    self.model.Add(sum(sessions) >= indicator)
                    self.model.Add(sum(sessions) <= len(sessions) * indicator)

    def _therapist_idle_gaps(self) -> None:
        # Identify idle gaps shaped like busy - idle - busy within a contiguous segment.
        segments = consecutive_segments()
        for therapist in self.instance.therapists:
            for day in DAY_ORDER:
                for segment in segments:
                    for idx in range(1, len(segment) - 1):
                        block = segment[idx]
                        prev_block = segment[idx - 1]
                        next_block = segment[idx + 1]
                        busy_prev = self.therapist_busy.get(
                            (therapist.id, day, prev_block)
                        )
                        busy_curr = self.therapist_busy.get((therapist.id, day, block))
                        busy_next = self.therapist_busy.get(
                            (therapist.id, day, next_block)
                        )
                        if (
                            busy_prev is not None
                            and busy_curr is not None
                            and busy_next is not None
                        ):
                            gap = self.model.NewBoolVar(
                                f"idle_{therapist.id}_{day}_{block}"
                            )
                            self.idle_gaps.append(gap)
                            self.model.Add(gap <= busy_prev)
                            self.model.Add(gap <= busy_next)
                            self.model.Add(gap <= 1 - busy_curr)

    def _patient_day_indicators(self) -> None:
        # Track whether a patient uses a given day (for objective minimization).
        for patient in self.instance.patients:
            for day in DAY_ORDER:
                vars_for_day = [
                    var
                    for (pid, _tid, _rid, d, _b), var in self.patient_sessions.items()
                    if pid == patient.id and d == day
                ]
                if not vars_for_day:
                    continue
                indicator = self.model.NewBoolVar(f"day_used_{patient.id}_{day}")
                self.patient_day_used[(patient.id, day)] = indicator
                self.model.Add(sum(vars_for_day) >= indicator)
                self.model.Add(sum(vars_for_day) <= len(vars_for_day) * indicator)

    def _add_objective(self) -> None:
        if self.diagnostic_mode == "soft":
            self._add_soft_objective()
            return
        if self.diagnostic_mode == "assumptions":
            self.model.Minimize(0)
            return
        # Minimize patient travel (days used) and therapist idle single-block gaps.
        terms = []
        if self.objective_weights.patient_days_weight:
            terms.append(
                self.objective_weights.patient_days_weight
                * sum(self.patient_day_used.values())
            )
        if self.objective_weights.therapist_idle_gap_weight:
            terms.append(
                self.objective_weights.therapist_idle_gap_weight * sum(self.idle_gaps)
            )
        if terms:
            self.model.Minimize(sum(terms))
        else:
            self.model.Minimize(0)

    def _add_soft_objective(self) -> None:
        terms: List[cp_model.IntVar] = []
        terms.extend(self.slack_patient_requirements.values())
        terms.extend(self.slack_no_same_day.values())
        terms.extend(self.slack_staffing.values())
        terms.extend(self.slack_session_min.values())
        terms.extend(self.slack_session_max.values())
        for items in self.slack_fixed_therapist.values():
            terms.extend(items)
        if terms:
            self.model.Minimize(sum(terms))
        else:
            self.model.Minimize(0)

    def _assumption_for(self, label: str) -> Optional[cp_model.IntVar]:
        if self.diagnostic_mode != "assumptions":
            return None
        if label not in self.assumptions:
            safe_label = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in label)
            var = self.model.NewBoolVar(f"assump_{safe_label}")
            self.assumptions[label] = var
            self.assumption_index_to_label[var.Index()] = label
        return self.assumptions[label]

    def _run_diagnostics(self) -> Dict[str, List[str]]:
        diagnostics: Dict[str, List[str]] = {}
        diagnostics["assumptions"] = self._diagnose_with_assumptions()
        diagnostics["prechecks"] = self._diagnose_infeasibility()
        diagnostics["soft"] = self._diagnose_with_soft_constraints()
        return diagnostics

    def _flatten_diagnostics(self, diagnostics: Dict[str, List[str]]) -> List[str]:
        flattened: List[str] = []
        for key in ("assumptions", "prechecks", "soft"):
            for item in diagnostics.get(key, []):
                flattened.append(f"{key}: {item}")
        return flattened

    def _diagnose_with_assumptions(self) -> List[str]:
        diagnostic = SchedulerModel(
            instance=self.instance,
            objective_weights=ObjectiveWeights(0, 0),
            solver_options=self.solver_options,
        )
        diagnostic.diagnostic_mode = "assumptions"
        diagnostic._build_variables()
        diagnostic._add_constraints()
        diagnostic._add_objective()

        if not diagnostic.assumptions:
            return ["No assumptions registered for diagnostics."]

        add_assumptions = getattr(diagnostic.model, "add_assumptions", None) or getattr(
            diagnostic.model, "AddAssumptions", None
        )
        if not add_assumptions:
            return ["Assumption diagnostics not supported by this OR-Tools version."]
        add_assumptions(list(diagnostic.assumptions.values()))
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.solver_options.time_limit
        solver.parameters.num_search_workers = 1
        status_code = solver.Solve(diagnostic.model)
        if status_code != cp_model.INFEASIBLE:
            return [f"Assumption model status: {self._status_name(status_code)}."]
        if not hasattr(solver, "sufficient_assumptions_for_infeasibility"):
            return ["Assumption core extraction not supported by this OR-Tools version."]
        core = solver.sufficient_assumptions_for_infeasibility()
        if not core:
            return ["Assumption core empty: infeasibility comes from unconditional constraints."]
        messages: List[str] = []
        for literal in core:
            label = diagnostic._label_for_literal(literal)
            if not label:
                messages.append(f"Unknown assumption literal {literal}.")
            else:
                messages.append(diagnostic._format_assumption_label(label))
        return messages

    def _label_for_literal(self, literal: int) -> Optional[str]:
        index = literal
        if literal < 0:
            index = -literal - 1
        return self.assumption_index_to_label.get(index)

    def _format_assumption_label(self, label: str) -> str:
        parts = label.split("|")
        kind = parts[0] if parts else label
        if kind == "patient_requirement" and len(parts) >= 3:
            return f"Patient {parts[1]} required sessions for therapy '{parts[2]}'."
        if kind == "no_same_day" and len(parts) >= 3:
            return f"Patient {parts[1]} no_same_day for therapy '{parts[2]}'."
        if kind == "staffing" and len(parts) >= 3:
            return f"Staffing requirement for therapy '{parts[1]}' specialty '{parts[2]}'."
        if kind == "session_capacity" and len(parts) >= 2:
            return f"Session capacity/min patients for therapy '{parts[1]}'."
        if kind == "patient_one_session" and len(parts) >= 2:
            return f"Patient {parts[1]} one-session-per-time constraint."
        if kind == "patient_continuous" and len(parts) >= 2:
            return f"Patient {parts[1]} continuous hours limit."
        if kind == "therapist_one_session" and len(parts) >= 2:
            return f"Therapist {parts[1]} one-session-per-time constraint."
        if kind == "room_one_session" and len(parts) >= 2:
            return f"Room {parts[1]} one-session-per-time constraint."
        if kind == "fixed_therapist" and len(parts) >= 5:
            return (
                f"Patient {parts[1]} fixed therapist {parts[4]} "
                f"for therapy '{parts[2]}' specialty '{parts[3]}'."
            )
        if kind == "pinned_session" and len(parts) >= 5:
            time_range = parts[4]
            try:
                time_range = block_to_range(int(parts[4]))
            except (ValueError, TypeError):
                pass
            return (
                f"Patient {parts[1]} pinned therapy '{parts[2]}' "
                f"on {parts[3]} {time_range}."
            )
        return label

    def _diagnose_with_soft_constraints(self) -> List[str]:
        diagnostic = SchedulerModel(
            instance=self.instance,
            objective_weights=ObjectiveWeights(0, 0),
            solver_options=self.solver_options,
        )
        diagnostic.diagnostic_mode = "soft"
        diagnostic._build_variables()
        diagnostic._add_constraints()
        diagnostic._add_objective()

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.solver_options.time_limit
        status_code = solver.Solve(diagnostic.model)
        if status_code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return [f"Soft diagnostic model status: {self._status_name(status_code)}."]
        return diagnostic._soft_diagnostics_from_solver(solver)

    def _soft_diagnostics_from_solver(self, solver: cp_model.CpSolver) -> List[str]:
        messages: List[str] = []
        for (patient_id, therapy_id), slack in self.slack_patient_requirements.items():
            value = solver.Value(slack)
            if value > 0:
                messages.append(
                    f"Patient {patient_id} missing {value} session(s) of therapy '{therapy_id}'."
                )
        for (patient_id, therapy_id, day), slack in self.slack_no_same_day.items():
            value = solver.Value(slack)
            if value > 0:
                messages.append(
                    f"Patient {patient_id} needs {value} extra '{therapy_id}' session(s) on {day} (no_same_day)."
                )
        for (therapy_id, room_id, day, block), slack in self.slack_session_min.items():
            value = solver.Value(slack)
            if value > 0:
                messages.append(
                    f"Session {therapy_id} in room {room_id} {day} {block_to_range(block)} "
                    f"short {value} patient(s) vs minimum."
                )
        for (therapy_id, room_id, day, block), slack in self.slack_session_max.items():
            value = solver.Value(slack)
            if value > 0:
                messages.append(
                    f"Session {therapy_id} in room {room_id} {day} {block_to_range(block)} "
                    f"over capacity by {value} patient(s)."
                )
        for (therapy_id, room_id, day, block, specialty), slack in self.slack_staffing.items():
            value = solver.Value(slack)
            if value > 0:
                messages.append(
                    f"Need +{value} '{specialty}' staff for therapy {therapy_id} "
                    f"in room {room_id} {day} {block_to_range(block)}."
                )
        for (patient_id, therapy_id, specialty, therapist_id), slacks in self.slack_fixed_therapist.items():
            total = sum(solver.Value(slack) for slack in slacks)
            if total > 0:
                messages.append(
                    f"Patient {patient_id} needs therapist {therapist_id} for '{therapy_id}' "
                    f"({specialty}), but {total} session(s) violate that requirement."
                )
        return self._limit_messages(messages)

    def _limit_messages(self, messages: Iterable[str], limit: int = 20) -> List[str]:
        items = list(messages)
        if len(items) <= limit:
            return items
        return items[:limit] + [f"...and {len(items) - limit} more"]

    def _status_name(self, status_code: int) -> str:
        status_lookup = {
            cp_model.UNKNOWN: "UNKNOWN",
            cp_model.MODEL_INVALID: "MODEL_INVALID",
            cp_model.FEASIBLE: "FEASIBLE",
            cp_model.OPTIMAL: "OPTIMAL",
            cp_model.INFEASIBLE: "INFEASIBLE",
        }
        return status_lookup.get(status_code, "UNKNOWN")

    def _diagnose_infeasibility(self) -> List[str]:
        messages: List[str] = []
        # Aggregate feasibility counts per patient/therapy and by day.
        therapy_slots_total: Dict[Tuple[str, str], int] = {}
        therapy_slots_by_day: Dict[Tuple[str, str, str], int] = {}
        therapy_global_slots: Dict[str, int] = {}
        staff_slots: Dict[Tuple[str, str], int] = {}
        rooms_by_therapy: Dict[str, List[str]] = {}
        required_patients_by_therapy: Dict[str, int] = {}
        therapist_by_id = {therapist.id: therapist for therapist in self.instance.therapists}

        for room in self.instance.rooms:
            for therapy_id in room.therapies:
                rooms_by_therapy.setdefault(therapy_id, []).append(room.id)

        for patient in self.instance.patients:
            for therapy_id, required in patient.therapies.items():
                if required > 0:
                    required_patients_by_therapy[therapy_id] = (
                        required_patients_by_therapy.get(therapy_id, 0) + 1
                    )

        for (pid, tid, _rid, day, _block), _var in self.patient_sessions.items():
            therapy_slots_total[(pid, tid)] = therapy_slots_total.get((pid, tid), 0) + 1
            therapy_slots_by_day[(pid, tid, day)] = (
                therapy_slots_by_day.get((pid, tid, day), 0) + 1
            )
            therapy_global_slots[tid] = therapy_global_slots.get(tid, 0) + 1

        for (_tid, therapy_id, _rid, _day, _block, specialty), _var in self.staffing.items():
            staff_slots[(therapy_id, specialty)] = staff_slots.get((therapy_id, specialty), 0) + 1

        for patient in self.instance.patients:
            for therapy_id, fixed in patient.fixed_therapists.items():
                if not fixed:
                    continue
                therapy_info = self.instance.therapies.get(therapy_id)
                if not therapy_info:
                    messages.append(
                        f"Patient {patient.id} fixes therapists for unknown therapy '{therapy_id}'."
                    )
                    continue
                for specialty, therapist_ids in fixed.items():
                    if not therapist_ids:
                        continue
                    ids = therapist_ids if isinstance(therapist_ids, list) else [therapist_ids]
                    ids = [tid for tid in ids if tid]
                    if not ids:
                        continue
                    required_count = therapy_info.requirements.get(specialty, 0)
                    if required_count == 0:
                        messages.append(
                            f"Patient {patient.id} fixes '{specialty}' for '{therapy_id}', "
                            "but the therapy does not require that specialty."
                        )
                        continue
                    if len(ids) > required_count:
                        messages.append(
                            f"Patient {patient.id} fixes {len(ids)} '{specialty}' therapist(s) for '{therapy_id}', "
                            f"but only {required_count} required."
                        )
                    if len(set(ids)) != len(ids):
                        messages.append(
                            f"Patient {patient.id} repeats a therapist for '{therapy_id}' ({specialty})."
                        )
                    for therapist_id in ids:
                        therapist = therapist_by_id.get(therapist_id)
                        if not therapist:
                            messages.append(
                                f"Patient {patient.id} fixes therapist '{therapist_id}' for '{therapy_id}', "
                                "but that therapist does not exist."
                            )
                            continue
                        if specialty not in therapist.specialties:
                            messages.append(
                                f"Therapist {therapist_id} lacks specialty '{specialty}' required by "
                                f"patient {patient.id} for '{therapy_id}'."
                            )
                            continue
                        has_slot = False
                        for (pid, tid, rid, day, block), _var in self.patient_sessions.items():
                            if pid != patient.id or tid != therapy_id:
                                continue
                            staff_key = (
                                therapist_id,
                                therapy_id,
                                rid,
                                day,
                                block,
                                specialty,
                            )
                            if staff_key in self.staffing:
                                has_slot = True
                                break
                        if not has_slot:
                            messages.append(
                                f"Patient {patient.id} requires therapist {therapist_id} for '{therapy_id}' "
                                f"({specialty}), but there are no slots where both are available in compatible rooms."
                            )

        for patient in self.instance.patients:
            for therapy_id, slots in patient.pinned_sessions.items():
                for slot in slots:
                    has_slot = any(
                        pid == patient.id
                        and tid == therapy_id
                        and day == slot.day
                        and block == slot.block
                        for (pid, tid, _rid, day, block), _var in self.patient_sessions.items()
                    )
                    if not has_slot:
                        messages.append(
                            f"Patient {patient.id} pins '{therapy_id}' on {slot.day} {block_to_range(slot.block)}, "
                            "but no feasible slot exists."
                        )

        for patient in self.instance.patients:
            for therapy_id, required in patient.therapies.items():
                if required <= 0:
                    continue
                rooms_for_therapy = rooms_by_therapy.get(therapy_id, [])
                availability_blocks = sum(
                    len(blocks) for blocks in patient.availability.values()
                )
                total_slots = therapy_slots_total.get((patient.id, therapy_id), 0)
                if total_slots < required:
                    if total_slots == 0:
                        if not rooms_for_therapy:
                            messages.append(
                                f"Patient {patient.id} needs '{therapy_id}', but no rooms allow this therapy."
                            )
                        if availability_blocks == 0:
                            messages.append(
                                f"Patient {patient.id} has no availability blocks to schedule '{therapy_id}'."
                            )
                    if total_slots > 0 or (rooms_for_therapy and availability_blocks > 0):
                        day_counts = {
                            day: therapy_slots_by_day.get((patient.id, therapy_id, day), 0)
                            for day in DAY_ORDER
                        }
                        available_days = (
                            ", ".join(f"{d}:{c}" for d, c in day_counts.items() if c > 0)
                            or "none"
                        )
                        messages.append(
                            f"Patient {patient.id} needs {required} '{therapy_id}' sessions but only "
                            f"{total_slots} feasible slots exist (by day {available_days})."
                        )
                else:
                    if therapy_id in patient.no_same_day_therapies:
                        max_per_week_with_rule = sum(
                            min(
                                1,
                                therapy_slots_by_day.get((patient.id, therapy_id, day), 0),
                            )
                            for day in DAY_ORDER
                        )
                        if max_per_week_with_rule < required:
                            messages.append(
                                f"Patient {patient.id} has 'no_same_day' for '{therapy_id}', allowing at most "
                                f"{max_per_week_with_rule} sessions per week but requires {required}."
                            )

        for therapy_id, therapy in self.instance.therapies.items():
            rooms_for_therapy = rooms_by_therapy.get(therapy_id, [])
            if not rooms_for_therapy:
                messages.append(
                    f"Therapy '{therapy_id}' is not allowed in any room."
                )
                continue
            if (
                therapy_global_slots.get(therapy_id, 0) == 0
                and required_patients_by_therapy.get(therapy_id, 0) > 0
            ):
                messages.append(
                    f"No feasible slots for therapy '{therapy_id}' with current patient availability."
                )
            for specialty in therapy.requirements.keys():
                if staff_slots.get((therapy_id, specialty), 0) == 0:
                    messages.append(
                        f"No feasible staff slots for therapy '{therapy_id}' specialty '{specialty}'."
                    )

        if not messages:
            messages.append(
                "Solver reported infeasible. Consider relaxing constraints "
                "(availability, max_continuous_hours, therapy staffing, no_same_day_therapies) "
                "or extending time limit."
            )
        return messages
