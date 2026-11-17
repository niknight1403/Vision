FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml ./
COPY vision_worker ./vision_worker
RUN pip install --no-cache-dir .
EXPOSE 8091
CMD ["python", "-m", "vision_worker.main"]
