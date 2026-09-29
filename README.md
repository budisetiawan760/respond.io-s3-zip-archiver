# S3 ZIP Archiver

Compresses newly uploaded S3 objects to ZIP, uploads the archive back to the same
bucket, and deletes the original. Deployed with AWS SAM and CloudFormation.

> **Status:** work in progress. Sections marked TODO are filled in as the build progresses.

## Architecture

TODO: diagram and narrative

## Design decisions

### Lambda reaches S3 through a VPC Gateway Endpoint, not a NAT Gateway

The brief requires the Lambda to run in private subnets. A Lambda in a private subnet
has no route to the internet, so calls to the S3 API need either a NAT Gateway or a
VPC Gateway Endpoint.

At Task 4 scale, this is the largest cost in the design:

| Route to S3 | Monthly cost at 7.2 PB |
|---|---|
| NAT Gateway ($0.045/GB processed) | ~$324,000 |
| S3 Gateway Endpoint | **$0** |

The template therefore defines no Internet Gateway and no NAT Gateway.

### The original object is deleted only after the ZIP is verified

`HeadObject` confirms the archive exists with exactly the size that was uploaded
before the source is removed. Deleting first would mean permanent data loss on a
partial upload. Versioning also keeps a recoverable copy of replaced objects for 7 days.

### Loop protection in two places

The function writes back into the bucket that triggers it. Without a guard, each `.zip`
would trigger another invocation forever. Guarded by a suffix filter on the S3 event
notification *and* an explicit check in the handler. A filter alone breaks the moment
someone edits the template.

### arm64 and image packaging

Graviton is roughly 20% cheaper per GB-second. `AutoPublishAlias` publishes a new
version on every deployment and moves the `live` alias, so rollback is repointing the
alias at the previous version.

## Deploy

```bash
sam build
sam deploy --guided       # first time
sam deploy                # subsequent
```

Tear down:

```bash
sam delete
```

## Task 4: Cost analysis

TODO

## Task 5: Scalability and bottlenecks

TODO
