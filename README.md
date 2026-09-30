# S3 ZIP Archiver

Compresses newly uploaded S3 objects to ZIP, uploads the archive back to the same bucket, and deletes the original. Deployed with AWS SAM and CloudFormation.

## Architecture

```
on-prem exporter
      │  PUT <prefix>/<name>.json
      ▼
S3 bucket  (versioned, SSE-S3 encryption, public access blocked,
      │     old versions expire after 7 days)
      │  s3:ObjectCreated:*  filtered to *.json
      ▼
Lambda "live" alias → published version  (container image, arm64, 512 MB)
      │  runs in 2 private subnets: no Internet Gateway, no NAT Gateway
      │  reaches S3 only through the S3 Gateway Endpoint on the subnets' route table
      ▼
1. GET the exact version from the event
2. zip it in memory (the entry keeps the original file name)
3. PUT <prefix>/<name>.json.zip into the same bucket
4. HEAD the zip and check its size matches what was uploaded
5. DELETE the original version (permanently, no delete marker)
```

Everything is defined in one CloudFormation stack in [`template.yaml`](template.yaml):

| Path                 | What it is                                                                              |
| -------------------- | --------------------------------------------------------------------------------------- |
| `template.yaml`    | VPC, subnets, route table, S3 Gateway Endpoint, security group, bucket, function, alias |
| `src/app.mjs`      | the Lambda handler                                                                      |
| `src/app.test.mjs` | unit tests with a faked S3 client                                                       |
| `src/Dockerfile`   | container image on the AWS Lambda Node.js 22 base image                                 |
| `samples/`         | sample processing-result JSON and a generator for test files                            |

## Design decisions

### Lambda reaches S3 through a VPC Gateway Endpoint, not a NAT Gateway

The brief requires the Lambda to run in private subnets. A Lambda in a private subnet has no route to the internet, so calls to the S3 API need either a NAT Gateway or a VPC Gateway Endpoint.

At Task 4 scale, this one choice is worth about $473,000 a month:

| Route to S3                                                       | Monthly cost (ap-southeast-1) |
| ----------------------------------------------------------------- | ----------------------------- |
| NAT Gateway ($0.059/GB processed, ~8 PB/month in both directions) | ~$473,000                     |
| S3 Gateway Endpoint                                               | $0                            |

The template therefore defines no Internet Gateway and no NAT Gateway.

### The original object is deleted only after the ZIP is verified

`HeadObject` confirms the archive exists with exactly the size that was uploaded before the source is removed. Deleting first would mean permanent data loss on a partial upload. Versioning also keeps a recoverable copy of replaced objects for 7 days.

### Loop protection in two places

The function writes back into the bucket that triggers it. Without a guard, each `.zip` would trigger another invocation forever. Guarded by a suffix filter on the S3 event notification *and* an explicit check in the handler. A filter alone breaks the moment someone edits the template.

### arm64, versions and rollback

Graviton is roughly 20% cheaper per GB-second. `AutoPublishAlias` publishes a new version on every deployment and moves the `live` alias, so rollback is repointing the alias at the previous version.

## Deploy

Requires the AWS SAM CLI, Docker and AWS credentials.

```bash
sam build
sam deploy --guided       # first time: pick a stack name and region, allow IAM role creation,
                          # and let SAM create the image repository
sam deploy                # later deploys reuse the saved answers
```

Every deploy publishes a new, immutable Lambda version and moves the `live` alias to it. The S3 trigger invokes the alias, so traffic always follows it.

## Test

Unit tests (no AWS access needed):

```bash
cd src && npm ci && node --test
```

End to end, after deploying (`<bucket>` is the `BucketName` stack output):

```bash
aws s3 cp samples/result-small.json s3://<bucket>/ABC/metadata.json
aws s3 ls s3://<bucket>/ABC/                  # after a few seconds: only metadata.json.zip
aws s3api list-object-versions --bucket <bucket> --prefix ABC/metadata.json \
  --query '{versions:Versions[].Key,deleteMarkers:DeleteMarkers[].Key}'
                                              # the original is gone: no version, no delete marker
sam logs -n ArchiverFunction --start-time '5min ago'   # {"key":...,"status":"ok",...}
```

## Roll back

Point the alias at an earlier version. No rebuild is needed, and it takes effect immediately:

```bash
aws lambda list-versions-by-function --function-name <function> --query 'Versions[].Version'
aws lambda update-alias --function-name <function> --name live --function-version <previous>
```

## Tear down

The bucket is versioned, and CloudFormation cannot delete a bucket that still holds objects, so empty it (every version) first:

```bash
aws s3api delete-objects --bucket <bucket> --delete "$(aws s3api list-object-versions \
  --bucket <bucket> --query '{Objects: [Versions,DeleteMarkers][][].{Key:Key,VersionId:VersionId}}' \
  --output json)"
sam delete
```

Deleting takes about half an hour (27 minutes in testing), while AWS releases the function's VPC network interfaces.

## Task 4: Cost analysis

All prices are on-demand list prices for ap-southeast-1 (Singapore), taken from the AWS Pricing API on 29 September 2026. I chose Singapore as the nearest established AWS region to Malaysia. Prices vary by region. us-east-1, for example, charges the same for Lambda compute and S3 requests, but about 9% less for S3 storage above 500 TB ($0.021 vs $0.023 per GB) and about 29% less for log ingestion ($0.50 vs $0.70 per GB). Re-price the tables below before using them for another region.

I measured duration, memory and compression ratio on the deployed stack.

### Inputs

| Input             | Value                                       | Source                                                           |
| ----------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| Files per month   | 1,000,000/hour × 730 hours = 730M          | brief                                                            |
| Data per month    | 730M × 10 MB = 7.3 PB                      | brief                                                            |
| Compression ratio | ZIP is 9.8% of the original (90.2% smaller) | measured on generated sample data; real exports may differ       |
| Lambda duration   | 1.38 s per 10 MB file at 512 MB, arm64      | measured in ap-southeast-1 (warm runs), scaled linearly to 10 MB |
| Requests per file | 1 GET, 1 PUT, 1 HEAD, 1 DELETE              | `src/app.mjs`                                                  |

A direct test with a 10.0 MB file measured 1.33 s warm (average of 4 runs), within 4% of the scaled estimate, so the tables keep the slightly conservative 1.38 s.

I left out cold starts, because at a steady ~385 concurrent executions the containers stay warm. I also left out the on-prem exporter's own PUTs (730M × $0.005/1,000 ≈ $3,650), because they exist with or without this feature.

### Monthly cost of running the feature

| Item                                          | Calculation                                                          | USD/month           |
| --------------------------------------------- | -------------------------------------------------------------------- | ------------------- |
| Lambda compute                                | 730M × 1.38 s × 0.5 GB × $0.0000133334/GB-s                       | 6,732               |
| Lambda requests                               | 730M × $0.20/1M                                                     | 146                 |
| S3 GET (download original)                    | 730M × $0.004/10,000                                                | 292                 |
| S3 HEAD (verify zip)                          | 730M × $0.004/10,000                                                | 292                 |
| S3 PUT (upload zip)                           | 730M × $0.005/1,000                                                 | 3,650               |
| S3 DELETE                                     | free                                                                 | 0                   |
| CloudWatch Logs                               | ~500 bytes per run = 365 GB × $0.70 ingest + $0.03/GB-month storage | 261                 |
| Network: S3 via Gateway Endpoint, same region | free                                                                 | 0                   |
| **Total**                               |                                                                      | **≈ 11,400** |

### Final monthly figure

The brief gives the volume and average size only, so this is the bill for the first full month of running the feature. Files arrive evenly across the month, and S3 bills storage by the average stored, so month 1 pays for about half of the month's data.

| Month 1                                                    | Without the feature | With the feature    |
| ---------------------------------------------------------- | ------------------- | ------------------- |
| Pipeline (table above)                                     | 0                   | 11,373              |
| S3 Standard storage (average 3.65 PB raw vs 358 TB zipped) | 84,500              | 8,639               |
| **Total (USD)**                                      | **84,500**    | **≈ 20,000** |

**Final figure: about $20,000 for the month, against $84,500 without the feature**, a saving of about $64,500. From month 2 onwards the gap widens, because each month's zips cost $17,013/month to store where the raw JSON would cost $168,450/month.

### Choosing the Lambda memory size

Lambda allocates CPU in proportion to memory, and compression is CPU-bound, so lower memory runs longer. I benchmarked the deployed function in ap-southeast-1 with the same file at four sizes (average of two warm runs each, scaled to 10 MB):

| Memory           | Duration per 10 MB file | GB-seconds per file | Compute USD/month | Concurrent executions |
| ---------------- | ----------------------- | ------------------- | ----------------- | --------------------- |
| 256 MB           | 2.89 s                  | 0.72                | 7,036             | ~800                  |
| **512 MB** | **1.38 s**        | **0.69**      | **6,732**   | **~385**        |
| 1024 MB          | 0.86 s                  | 0.86                | 8,337             | ~240                  |
| 1769 MB          | 0.55 s                  | 0.95                | 9,220             | ~150                  |

Peak memory was ~190 MB at every size. 10 MB is an average, so I also ran larger files to check the headroom:

| File size | 256 MB           | 512 MB |
| --------- | ---------------- | ------ |
| 25 MB     | 8.1 s            | 4.0 s  |
| 50 MB     | 13.8 s           | 6.8 s  |
| 80 MB     | **failed** | 9.3 s  |

The template uses 512 MB. It was the cheapest per file in this run, 19% cheaper than 1024 MB, and it handles 80 MB files. 256 MB costs about the same because it runs twice as long, and it fails on large files and would need ~800 concurrent executions against the default account limit of 1,000.

### Suggestions to save more

1. Move zips to S3 Glacier Instant Retrieval after 30 days with a lifecycle rule. It costs $0.005 instead of $0.023 per GB-month, which takes one month of zips from $17,013 to $3,579/month. It saves nothing in month 1, because nothing is 30 days old yet. The transition fee is $0.02 per 1,000 objects ($14,600 for one month of per-file zips), and the lower storage price repays it in about five weeks. Glacier IR also charges a 90-day minimum and $0.03/GB on every read, so it fits data that is rarely read after the first month.
2. Batch files per archive, with S3 → SQS → Lambda and a 5-minute batching window. Compute stays the same, because it scales with bytes processed, not with invocations. PUT and HEAD requests drop from $3,942 to ~$4, Lambda requests from $146 to ~$0, and SQS adds ~$350, so it saves about $3,700/month. Fewer, larger objects also make the Glacier transition fee in (1) negligible. The cost is a different design from one zip per object (what Task 1 asks for): it needs an index to find a file inside a bundle, and partial-batch failure handling. ZIP compresses each entry separately, so bundling does not improve the compression ratio.
3. Tune the compression level. Compute is ~59% of the running cost, and zlib level 1 is much faster than level 6 with slightly larger output. I would benchmark it against the storage cost of the larger zips before changing it.
4. Buy a Compute Savings Plan: up to 17% off Lambda compute (~$1,100/month) for a 1- or 3-year commitment.
5. Set a log retention period, for example 14 days. Without one, CloudWatch keeps the 365 GB/month of logs forever.

## Task 5: Scalability and bottlenecks

Yes to both, within the limits below.

Every file triggers its own invocation, and invocations share no state, so Lambda runs more of them in parallel as uploads increase. At 1,000,000 files/hour (278 files/s × 1.38 s each), that is about 385 concurrent executions.

It is cost-efficient compared with not archiving: about $20,000 against $84,500 in month 1 (Task 4). The main inefficiency is per-object overhead, because every file costs one invocation and four S3 requests.

### Burst test

I tested scaling on the deployed stack in ap-southeast-1. I generated 500 different JSON files (53 to 788 KB, random content) and fired all 500 S3 events within 1.0 second:

| Metric (CloudWatch)                                           | Result                  |
| ------------------------------------------------------------- | ----------------------- |
| Invocations                                                   | 500                     |
| Peak concurrent executions                                    | 355                     |
| Throttles                                                     | 0                       |
| Errors                                                        | 0                       |
| Longest time an event waited in the queue (`AsyncEventAge`) | 0.24 s                  |
| All 500 zipped and originals deleted                          | within 7 s of the burst |
| Delete markers left behind                                    | 0                       |
| Zip content matches the original (MD5, 5 random samples)      | 5/5                     |

A single 10.0 MB file at 512 MB takes 1.33 s warm, with a peak of 220 MB (43% of the memory). The first run in a new execution environment adds a 0.65 s cold start, which is billed. At steady load almost every invocation is warm, so cold starts only matter during spikes.

### Capacity

| Limit                                                         | Load at 1M files/hour | Headroom                                           |
| ------------------------------------------------------------- | --------------------- | -------------------------------------------------- |
| Lambda concurrency: 1,000 per account per region (default)    | ~385                  | 2.6× (ceiling ~725 files/s, or ~2.6M files/hour)  |
| S3 writes: 3,500/s per prefix (export PUT + zip PUT + DELETE) | ~830/s                | ~4×                                               |
| S3 reads: 5,500/s per prefix (GET + HEAD)                     | ~560/s                | ~10×                                              |
| File size at 512 MB                                           | 10 MB average         | 80 MB tested successfully (256 MB failed at 80 MB) |

### Concerns and bottlenecks

1. The 1,000 concurrency limit is shared by every Lambda function in the account and region. If the exporter sends files in bursts, or another workload is busy, invocations are throttled. S3 invokes Lambda asynchronously, so throttled events are retried for up to 6 hours; they are delayed, not lost. A dump of one hour's 1M files at once would take about 23 minutes to drain at the limit. I would request a higher limit and set reserved concurrency, so this function and other workloads cannot starve each other.
2. Lambda retries a failed asynchronous event twice, then discards it. The original JSON stays in the bucket, because it is only deleted after the zip is verified, so no data is lost, but nothing reports the failure. At a 0.01% failure rate that is ~100 unarchived files per hour. An on-failure destination (SQS) with an alarm on its depth would catch them.
3. The trigger only fires for new objects. Everything already in the bucket, which is the growth the company wants to fix, stays uncompressed. A one-time backfill with S3 Batch Operations can invoke the function for each existing object. Batch Operations sends a different event shape, so the handler needs a small adapter.
4. The function holds the file, a copy and the zip in memory. 512 MB handled 80 MB, but a much larger file would fail on every retry. Streaming from S3 through the zip into a multipart upload keeps memory flat for any file size.
5. S3 delivers events at least once and does not guarantee order. The handler already copes with duplicates: reads and deletes are pinned to the event's version ID, and it skips a version that is already deleted. If the same key is re-uploaded within seconds, the last zip written wins, and that may be the older content. Comparing the event's `sequencer` value, which S3 orders per key, before overwriting would prevent it.
6. If every file lands under one prefix, writes use ~24% of that prefix's limit. That is fine at 1M/hour, but a 4× spike would reach it, and S3 would return `503 Slow Down`. Spreading exports across prefixes, for example by date or video ID, lets S3 partition the load.
7. There is no monitoring yet. I would add CloudWatch alarms on `Errors`, `Throttles` and `AsyncEventAge`, plus the depth of the on-failure queue from (2).

### Cost efficiency at this scale

S3 requests are ~37% of the running cost (PUT alone is 32%), and anything priced per object multiplies across 730M files a month, such as lifecycle transitions or Intelligent-Tiering monitoring. Bundling many files per archive (Task 4, suggestion 2) removes most of that overhead.

The load is also flat, around 385 concurrent executions all day, and flat load is where servers get cheaper than Lambda. I estimate an SQS-fed pool of ECS Fargate workers would cost about 24% less for compute (~$1,700/month). The estimate assumes ~0.34 CPU-seconds per file, derived from the memory benchmark. I kept Lambda because the task asks for it, and because it needs no servers, scales in seconds (the burst test reached 355 environments in about one second) and retries failures by itself. A worker pool becomes the better design if files are batched into large archives, which would exceed Lambda's 15-minute and 10 GB limits, or if the compute bill grows enough to pay for running the fleet.

Traffic between S3 and Lambda stays in the region and goes through the Gateway Endpoint, so it is free. Anyone who later downloads archives out of AWS transfers ~90% less data than with the raw JSON.
