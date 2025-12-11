from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import hydra
from hydra.utils import get_original_cwd
from omegaconf import DictConfig

from .data_loader import load_instance
from .excel_writer import export_excel
from .model import ObjectiveWeights, SchedulerModel, SolverOptions


@hydra.main(version_base="1.3", config_path="../../config", config_name="config")
def main(cfg: DictConfig) -> None:
    base_dir = Path(get_original_cwd())

    instance_path = (base_dir / cfg.data.instance_path).resolve()
    output_path = (base_dir / cfg.output.path).resolve()

    instance = load_instance(instance_path)
    objective_weights = ObjectiveWeights(**cfg.objectives)
    solver_options = SolverOptions(**cfg.solver)

    scheduler = SchedulerModel(
        instance=instance,
        objective_weights=objective_weights,
        solver_options=solver_options,
    )
    result = scheduler.solve()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_payload: Dict[str, Any] = {
        "status": result.status,
        "objective_value": result.objective_value,
        "schedule": result.schedule,
        "diagnostics": result.diagnostics,
    }
    output_path.write_text(json.dumps(output_payload, indent=2))

    excel_path = Path(cfg.output.excel_path) if "excel_path" in cfg.output else None
    if excel_path:
        excel_full = (base_dir / excel_path).resolve()
        export_excel(result.schedule, excel_full)

    print(f"Status: {result.status}")
    print(f"Objective: {result.objective_value}")
    print(f"Wrote schedule with {len(result.schedule)} appointments to {output_path}")
    if excel_path:
        print(f"Wrote Excel calendar to {excel_full}")
    if result.status == "INFEASIBLE" and result.diagnostics:
        print("Diagnostics:")
        for msg in result.diagnostics:
            print(f"- {msg}")


if __name__ == "__main__":
    main()
