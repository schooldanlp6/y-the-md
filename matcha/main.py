"""Application entry point.

Creates the Flask app, registers the auth guard and router, and starts the
server. Run with: python -m matcha.main
"""
from __future__ import annotations

import logging

from flask import Flask, jsonify

from . import auth, config, cors, runner
from .router import api


def create_app() -> Flask:
    app = Flask(__name__)
    app.register_blueprint(api)
    cors.register(app)
    auth.register(app)
    runner.runner.start()

    @app.errorhandler(404)
    def not_found(_):
        return jsonify({"error": "not found"}), 404

    @app.errorhandler(500)
    def server_error(_):
        return jsonify({"error": "internal server error"}), 500

    return app


app = create_app()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.DEBUG if config.DEBUG else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG)
