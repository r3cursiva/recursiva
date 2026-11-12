# Plane's uploads as a tar on stdout, each file named by its asset id. Lines "<asset id>\t<object key>" come on stdin.
#
# Runs inside Plane's api container: boto3 and the storage settings are there, so no secret leaves it. MinIO keeps small
# objects inside xl.meta, so the bucket's directory on disk cannot be read as files. Only reads.
# tools/release/src/plane-sync.ts passes this file through `python -c`.
import os
import sys
import tarfile

import boto3

s3 = boto3.client("s3", endpoint_url=os.environ["AWS_S3_ENDPOINT_URL"], region_name=os.environ.get("AWS_REGION"))
bucket = os.environ["AWS_S3_BUCKET_NAME"]

with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as tar:
    for line in sys.stdin:
        asset, key = line.rstrip("\n").split("\t", 1)
        try:
            body = s3.get_object(Bucket=bucket, Key=key)
        except s3.exceptions.NoSuchKey:
            print("no object for", asset, file=sys.stderr)
            continue
        info = tarfile.TarInfo(asset)
        info.size = body["ContentLength"]
        tar.addfile(info, body["Body"])
