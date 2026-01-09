from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

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

    def solve(self) -> SolveResult:
        self._build_variables()
        self._add_constraints()
        self._add_objective()

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.solver_options.time_limit
        solver.parameters.log_search_progress = self.solver_options.log_search_progress

        status_code = solver.Solve(self.model)
        status_lookup = {
            cp_model.UNKNOWN: "UNKNOWN",
            cp_model.MODEL_INVALID: "MODEL_INVALID",
            cp_model.FEASIBLE: "FEASIBLE",
            cp_model.OPTIMAL: "OPTIMAL",
            cp_model.INFEASIBLE: "INFEASIBLE",
        }
        status_name = status_lookup.get(status_code, "UNKNOWN")

        schedule: List[Dict[str, object]] = []
        diagnostics: List[str] = []
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
            diagnostics = self._diagnose_infeasibility()

        return SolveResult(
            status=status_name,
            objective_value=solver.ObjectiveValue(),
            schedule=schedule,
            diagnostics=diagnostics,
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
        for therapy_id, therapy in self.instance.therapies.items():
            for room in self.instance.rooms:
                if therapy_id not in room.therapies:
                    continue
                for day in DAY_ORDER:
                    for block in BLOCKS:
                        session_var = self._get_session_var(therapy_id, room.id, day, block)
                        for specialty in therapy.requirements.keys():
                            for therapist in self.instance.therapists:
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
                                if staff_key in self.staffing:
                                    continue
                                staff_var = self.model.NewBoolVar(
                                    f"t_{therapist.id}_{therapy_id}_{room.id}_{day}_{block}_{specialty}"
                                )
                                self.staffing[staff_key] = staff_var
                                self.model.Add(staff_var <= session_var)

        for patient in self.instance.patients:
            for therapy_id, required in patient.therapies.items():
                if required <= 0:
                    continue
                for day in DAY_ORDER:
                    if day not in patient.availability:
                        continue
                    for block in patient.availability.get(day, set()):
                        for room in self.instance.rooms:
                            if therapy_id not in room.therapies:
                                continue
                            session_var = self._get_session_var(therapy_id, room.id, day, block)
                            var_name = f"x_{patient.id}_{therapy_id}_{room.id}_{day}_{block}"
                            assign_var = self.model.NewBoolVar(var_name)
                            self.patient_sessions[
                                (patient.id, therapy_id, room.id, day, block)
                            ] = assign_var
                            # Patient can only join an active session.
                            self.model.Add(assign_var <= session_var)

        self._ensure_feasibility_of_requirements()

    def _ensure_feasibility_of_requirements(self) -> None:
        # Fail early if any patient/therapy has no feasible assignment variables at all.
        for patient in self.instance.patients:
            for therapy_id, required in patient.therapies.items():
                matching_vars = [
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
                if required > 0 and not matching_vars:
                    raise ValueError(
                        f"No feasible slots for patient {patient.id} and therapy {therapy_id}. "
                        "Check availability and room compatibility."
                    )

    def _add_constraints(self) -> None:
        self._session_capacity_constraints()
        self._staffing_requirements()
        self._patient_requirements()
        self._patient_no_same_day_therapies()
        self._one_session_per_time()
        self._patient_continuous_hours_limit()
        self._therapist_and_room_single_session()
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
            self.model.Add(total_patients <= max_allowed)
            # If the session is active, enforce minimum patients.
            self.model.Add(total_patients >= therapy_info.min_patients * session_var)

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
                if staff_vars:
                    self.model.Add(sum(staff_vars) == required * session_var)
                else:
                    # No available staff for this specialty in this slot.
                    if required > 0:
                        self.model.Add(session_var == 0)

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
                    self.model.Add(sum(vars_for_requirement) == required)

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
                        self.model.Add(sum(vars_for_day) <= 1)

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
                        self.model.Add(sum(overlapping) <= 1)

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
                            self.model.Add(sum(window_vars) <= limit)

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
                        self.model.Add(sum(sessions) <= 1)

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
                        self.model.Add(sum(sessions) <= 1)

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

    def _diagnose_infeasibility(self) -> List[str]:
        messages: List[str] = []
        # Aggregate feasibility counts per patient/therapy and by day.
        therapy_slots_total: Dict[Tuple[str, str], int] = {}
        therapy_slots_by_day: Dict[Tuple[str, str, str], int] = {}
        therapy_global_slots: Dict[str, int] = {}
        staff_slots: Dict[Tuple[str, str], int] = {}

        for (pid, tid, _rid, day, _block), _var in self.patient_sessions.items():
            therapy_slots_total[(pid, tid)] = therapy_slots_total.get((pid, tid), 0) + 1
            therapy_slots_by_day[(pid, tid, day)] = (
                therapy_slots_by_day.get((pid, tid, day), 0) + 1
            )
            therapy_global_slots[tid] = therapy_global_slots.get(tid, 0) + 1

        for (_tid, therapy_id, _rid, _day, _block, specialty), _var in self.staffing.items():
            staff_slots[(therapy_id, specialty)] = staff_slots.get((therapy_id, specialty), 0) + 1

        for patient in self.instance.patients:
            for therapy_id, required in patient.therapies.items():
                total_slots = therapy_slots_total.get((patient.id, therapy_id), 0)
                if total_slots < required:
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
            if therapy_global_slots.get(therapy_id, 0) == 0:
                messages.append(
                    f"No feasible slots for therapy '{therapy_id}' across rooms/patient availability."
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
