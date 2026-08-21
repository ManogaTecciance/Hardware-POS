#!/bin/bash
# D82 — create the uploads bucket as soon as LocalStack is ready.
#
# LocalStack's community image does not persist objects across container
# re-creation (that is a Pro feature), so a bucket made by hand disappears the
# next time the stack is rebuilt — and the only symptom is "The specified
# bucket does not exist" on the first image upload, hours later, from a part
# of the app that has nothing to do with Docker.
#
# Scripts in /etc/localstack/init/ready.d run once the services are up, so the
# bucket is there before anything can ask for it. Idempotent: re-running on an
# existing bucket is a no-op, not an error.
set -euo pipefail

BUCKET="${UPLOADS_BUCKET:-hardware-pos-uploads}"

if awslocal s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "[init] bucket s3://$BUCKET already exists"
else
  awslocal s3 mb "s3://$BUCKET"
  echo "[init] created bucket s3://$BUCKET"
fi
