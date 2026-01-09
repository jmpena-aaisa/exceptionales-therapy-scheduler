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
    therapies: Dict[str, int]
    availability: Dict[str, Set[int]]
    max_continuous_hours: int = 3
    no_same_day_therapies: Set[str] = field(default_factory=set)


@dataclass
class Room:
    id: str
    therapies: Set[str]
    capacity: int


@dataclass
class TherapyInfo:
    requirements: Dict[str, int]
    min_patients: int
    max_patients: int


@dataclass
class Instance:
    therapists: List[Therapist]
    patients: List[Patient]
    rooms: List[Room]
    specialties: Set[str]
    therapies: Dict[str, TherapyInfo]


def load_instance(path: Path) -> Instance:
    data = json.loads(path.read_text())

    specialties_raw = data.get("specialties", [])
    if isinstance(specialties_raw, dict):
        specialties = set(specialties_raw.keys())
    else:
        specialties = set()
        for item in specialties_raw:
            if isinstance(item, str):
                specialties.add(item)
            elif isinstance(item, dict) and item.get("id"):
                specialties.add(str(item["id"]))

    therapies_raw = data.get("therapies", [])
    if isinstance(therapies_raw, dict):
        therapies_iter = [{"id": key, **value} for key, value in therapies_raw.items()]
    else:
        therapies_iter = therapies_raw

    therapies: Dict[str, TherapyInfo] = {}
    for item in therapies_iter:
        if not isinstance(item, dict):
            continue
        therapy_id = item.get("id")
        if not therapy_id:
            continue
        requirements = {
            str(name): int(count)
            for name, count in item.get("requirements", {}).items()
        }
        therapies[therapy_id] = TherapyInfo(
            requirements=requirements,
            min_patients=int(item.get("min_patients", 1)),
            max_patients=int(item.get("max_patients", 1)),
        )

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
            therapies=patient.get("therapies", {}),
            availability=availability_to_blocks_per_day(
                patient.get("availability", {})
            ),
            max_continuous_hours=patient.get("max_continuous_hours", 3),
            no_same_day_therapies=set(patient.get("no_same_day_therapies", [])),
        )
        for patient in data.get("patients", [])
    ]

    rooms = [
        Room(
            id=room["id"],
            therapies=set(room.get("therapies", [])),
            capacity=int(room.get("capacity", 1)),
        )
        for room in data.get("rooms", [])
    ]

    _validate_instance(therapists, patients, rooms, specialties, therapies)
    return Instance(
        therapists=therapists,
        patients=patients,
        rooms=rooms,
        specialties=specialties,
        therapies=therapies,
    )


def _validate_instance(
    therapists: List[Therapist],
    patients: List[Patient],
    rooms: List[Room],
    specialties: Set[str],
    therapies: Dict[str, TherapyInfo],
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

    for therapist in therapists:
        for specialty in therapist.specialties:
            if specialty not in specialties:
                raise ValueError(
                    f"Unknown specialty '{specialty}' for therapist {therapist.id}."
                )

    for therapy_id, info in therapies.items():
        if info.min_patients < 1 or info.max_patients < info.min_patients:
            raise ValueError(f"Invalid patient bounds for therapy '{therapy_id}': {info}.")
        if not info.requirements:
            raise ValueError(f"Therapy '{therapy_id}' must define required specialties.")
        for specialty, count in info.requirements.items():
            if specialty not in specialties:
                raise ValueError(
                    f"Unknown specialty '{specialty}' in therapy {therapy_id}."
                )
            if count <= 0:
                raise ValueError(
                    f"Therapy {therapy_id} requires positive count for '{specialty}'."
                )

    for patient in patients:
        for therapy_id, required in patient.therapies.items():
            if therapy_id not in therapies:
                raise ValueError(
                    f"Unknown therapy '{therapy_id}' for patient {patient.id}."
                )
            if required < 0:
                raise ValueError(
                    f"Requirement for therapy '{therapy_id}' must be non-negative."
                )
        for therapy_id in patient.no_same_day_therapies:
            if therapy_id not in therapies:
                raise ValueError(
                    f"Unknown therapy '{therapy_id}' in no_same_day_therapies for patient {patient.id}."
                )

    for room in rooms:
        if room.capacity < 1:
            raise ValueError(f"Room {room.id} capacity must be positive.")
        for therapy_id in room.therapies:
            if therapy_id not in therapies:
                raise ValueError(
                    f"Unknown therapy '{therapy_id}' for room {room.id}."
                )

    for entity in [*therapists, *patients]:
        for avail_day in entity.availability.keys():
            if avail_day not in DAY_ORDER:
                raise ValueError(f"Invalid day '{avail_day}' for {entity}.")
