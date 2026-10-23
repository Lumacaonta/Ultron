import os

import uvicorn
from main import app


def _backend_port() -> int:
    raw_port = os.getenv("ULTRON_PORT", "8000").strip()
    try:
        port = int(raw_port)
    except ValueError as error:
        raise RuntimeError("ULTRON_PORT must be a valid TCP port.") from error

    if not 1 <= port <= 65535:
        raise RuntimeError("ULTRON_PORT must be between 1 and 65535.")

    return port


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=_backend_port(),
    )
