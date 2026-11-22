#!/bin/bash
set +e
python3 tools/nowcast-test.py 7 > out/nowcast.txt 2>&1
