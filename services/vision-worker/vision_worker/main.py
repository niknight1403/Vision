"""Run the private Hidden Treasure worker HTTP service."""
import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "vision_worker.service:app",
        host=os.getenv("VISION_WORKER_HOST", "0.0.0.0"),
        port=int(os.getenv("VISION_WORKER_PORT", "8091")),
        workers=1,
    )
