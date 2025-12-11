from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence, Set

DAY_ORDER: List[str] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]

# Nine one-hour blocks (08-13, break, 14-18)
BLOCKS: List[int] = list(range(9))
BLOCK_TO_RANGE: Dict[int, str] = {
    0: "08:00-09:00",
    1: "09:00-10:00",
    2: "10:00-11:00",
    3: "11:00-12:00",
    4: "12:00-13:00",
    5: "14:00-15:00",
    6: "15:00-16:00",
    7: "16:00-17:00",
    8: "17:00-18:00",
}


@dataclass(frozen=True)
class Interval:
    start_minutes: int
    end_minutes: int

    @classmethod
    def parse(cls, interval_str: str) -> "Interval":
        start_str, end_str = interval_str.split("-")
        return cls(_to_minutes(start_str), _to_minutes(end_str))

    def contains_block(self, block: int) -> bool:
        """Return True if the hour block is fully inside the interval."""
        block_interval = block_minutes(block)
        return (
            self.start_minutes <= block_interval.start_minutes
            and block_interval.end_minutes <= self.end_minutes
        )


def _to_minutes(clock: str) -> int:
    hours, minutes = clock.split(":")
    return int(hours) * 60 + int(minutes)


def block_minutes(block: int) -> Interval:
    """Get the start/end minutes for a block."""
    mapping = {
        0: Interval(8 * 60, 9 * 60),
        1: Interval(9 * 60, 10 * 60),
        2: Interval(10 * 60, 11 * 60),
        3: Interval(11 * 60, 12 * 60),
        4: Interval(12 * 60, 13 * 60),
        5: Interval(14 * 60, 15 * 60),
        6: Interval(15 * 60, 16 * 60),
        7: Interval(16 * 60, 17 * 60),
        8: Interval(17 * 60, 18 * 60),
    }
    return mapping[block]


def block_to_range(block: int) -> str:
    return BLOCK_TO_RANGE[block]


def range_to_block(range_str: str) -> int:
    inverted = {v: k for k, v in BLOCK_TO_RANGE.items()}
    if range_str not in inverted:
        raise ValueError(f"Unknown time range '{range_str}'.")
    return inverted[range_str]


def intervals_to_block_set(intervals: Iterable[str]) -> Set[int]:
    """Convert a list of interval strings to the set of hour block indices they cover."""
    interval_objs = [Interval.parse(i) for i in intervals]
    return {b for b in BLOCKS if any(interval.contains_block(b) for interval in interval_objs)}


def availability_to_blocks_per_day(avail_map: Dict[str, Sequence[str]]) -> Dict[str, Set[int]]:
    """Normalize availability dict of day -> intervals into day -> blocks set."""
    normalized: Dict[str, Set[int]] = {}
    for day, intervals in avail_map.items():
        if not intervals:
            continue
        normalized[day] = intervals_to_block_set(intervals)
    return normalized


def consecutive_segments() -> List[List[int]]:
    """Return segments of blocks that are consecutive in time (morning vs afternoon)."""
    # Lunch break sits between 4 and 5, so treat them as separate streaks.
    return [list(range(0, 5)), list(range(5, 9))]
