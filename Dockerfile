FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/src

WORKDIR /app

# Install uv for dependency management
RUN pip install --no-cache-dir uv

COPY pyproject.toml ./
COPY README.md ./README.md
COPY src ./src
COPY config ./config
COPY data ./data

# Install project and dependencies
RUN uv pip install --system --editable .

COPY output ./output

CMD ["python", "-m", "therapy_scheduler.main"]
