#!/bin/bash
set +e
python3 tools/backtest-year.py out/year.json.gz > out/log.txt 2>&1
