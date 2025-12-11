from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Set

from .time_utils import DAY_ORDER, availability_to_blocks_per_day


@dataclass
class Therapist:
    id: str
    specialties: Set[str]
    availability: Dict[str, Set[int]]


@dataclass
class Patient:
    id: str
    requirements: Dict[str, int]
    availability: Dict[str, Set[int]]
    max_continuous_hours: int = 3
    no_same_day_specialties: Set[str] = field(default_factory=set)


@dataclass
class Room:
    id: str
    specialties: Set[str]
    capacity: int


@dataclass
class SpecialtyInfo:
    min_quorum: int
    max_quorum: int


@dataclass
class Instance:
    therapists: List[Therapist]
    patients: List[Patient]
    rooms: List[Room]
    specialties: Dict[str, SpecialtyInfo]


def load_instance(path: Path) -> Instance:
    data = json.loads(path.read_text())

    specialties = {
        name: SpecialtyInfo(**info)
        for name, info in data.get("specialties", {}).items()
    }

    therapists = [
        Therapist(
            id=therapist["id"],
            specialties=set(therapist.get("specialties", [])),
            availability=availability_to_blocks_per_day(
                therapist.get("availability", {})
            ),
        )
        for therapist in data.get("therapists", [])
    ]

    patients = [
        Patient(
            id=patient["id"],
            requirements=patient.get("requirements", {}),
            availability=availability_to_blocks_per_day(
                patient.get("availability", {})
            ),
            max_continuous_hours=patient.get("max_continuous_hours", 3),
            no_same_day_specialties=set(patient.get("no_same_day_specialties", [])),
        )
        for patient in data.get("patients", [])
    ]

    rooms = [
        Room(
            id=room["id"],
            specialties=set(room.get("specialties", [])),
            capacity=int(room.get("capacity", 1)),
        )
        for room in data.get("rooms", [])
    ]

    _validate_instance(therapists, patients, rooms, specialties)
    return Instance(
        therapists=therapists,
        patients=patients,
        rooms=rooms,
        specialties=specialties,
    )


def _validate_instance(
    therapists: List[Therapist],
    patients: List[Patient],
    rooms: List[Room],
    specialties: Dict[str, SpecialtyInfo],
) -> None:
    therapist_ids = {t.id for t in therapists}
    if len(therapist_ids) != len(therapists):
        raise ValueError("Therapist ids must be unique.")

    patient_ids = {p.id for p in patients}
    if len(patient_ids) != len(patients):
        raise ValueError("Patient ids must be unique.")

    room_ids = {r.id for r in rooms}
    if len(room_ids) != len(rooms):
        raise ValueError("Room ids must be unique.")

    for patient in patients:
        for specialty, required in patient.requirements.items():
            if specialty not in specialties:
                raise ValueError(
                    f"Unknown specialty '{specialty}' for patient {patient.id}."
                )
            if required < 0:
                raise ValueError(f"Requirement for {specialty} must be non-negative.")
        for specialty in patient.no_same_day_specialties:
            if specialty not in specialties:
                raise ValueError(
                    f"Unknown specialty '{specialty}' in no_same_day_specialties for patient {patient.id}."
                )

    for specialty, info in specialties.items():
        if info.min_quorum < 1 or info.max_quorum < info.min_quorum:
            raise ValueError(f"Invalid quorum for {specialty}: {info}.")

    for entity in [*therapists, *patients]:
        for avail_day in entity.availability.keys():
            if avail_day not in DAY_ORDER:
                raise ValueError(f"Invalid day '{avail_day}' for {entity}.")
