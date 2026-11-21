# -*- coding: utf-8 -*-
"""Web 控制台入口（薄封装，实际实现在 web/server.py）。"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "web"))

from server import main  # noqa: E402

if __name__ == "__main__":
    main()
