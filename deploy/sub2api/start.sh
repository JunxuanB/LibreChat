#!/bin/sh
set -eu
set -a
. "${SUB2API_STATE_DIR:-/app/data/sub2api}/secrets.env"
set +a
exec npm run backend
