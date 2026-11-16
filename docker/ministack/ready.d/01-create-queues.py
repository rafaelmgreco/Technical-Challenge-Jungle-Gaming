import json
import os

import boto3


client = boto3.client(
    "sqs",
    endpoint_url=os.environ.get("AWS_ENDPOINT_URL", "http://localhost:4566"),
    region_name=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
)
client.create_queue(QueueName="jungle-integration-events")

dead_letter_queue = client.create_queue(
    QueueName="wager-transactions-dlq.fifo",
    Attributes={"FifoQueue": "true", "ContentBasedDeduplication": "false"},
)
dead_letter_arn = client.get_queue_attributes(
    QueueUrl=dead_letter_queue["QueueUrl"],
    AttributeNames=["QueueArn"],
)["Attributes"]["QueueArn"]
client.create_queue(
    QueueName="wager-transactions.fifo",
    Attributes={
        "FifoQueue": "true",
        "ContentBasedDeduplication": "false",
        "VisibilityTimeout": "30",
        "RedrivePolicy": json.dumps({"deadLetterTargetArn": dead_letter_arn, "maxReceiveCount": "5"}),
    },
)
