import os

import boto3


client = boto3.client(
    "sqs",
    endpoint_url=os.environ.get("AWS_ENDPOINT_URL", "http://localhost:4566"),
    region_name=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
)
client.create_queue(QueueName="jungle-integration-events")
