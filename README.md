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

| Route to S3 | Monthly cost (ap-southeast-1) |
|---|---|
| NAT Gateway ($0.059/GB processed, ~8 PB/month in both directions) | ~$473,000 |
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

All prices are on-demand list prices for **ap-southeast-1 (Singapore)**, taken from the AWS
Pricing API on 29 September 2026. Singapore is the closest established AWS region to the
company. **Prices vary by region**: for example, us-east-1 charges the same for Lambda
compute and S3 requests, but about 9% less for S3 storage above 500 TB ($0.021 vs $0.023
per GB) and about 29% less for log ingestion ($0.50 vs $0.70 per GB). Re-price the tables
below before using them for another region.

Performance numbers (duration, memory, compression ratio) were measured on the deployed stack.

### Inputs

| Input | Value | Source |
|---|---|---|
| Files per month | 1,000,000/hour × 730 hours = **730M** | brief |
| Data per month | 730M × 10 MB = **7.3 PB** | brief |
| Compression ratio | ZIP is **9.8%** of the original (90.2% smaller) | measured on generated sample data; real exports may differ |
| Lambda duration | **1.38 s** per 10 MB file at 512 MB, arm64 | measured in ap-southeast-1 (warm runs), scaled linearly to 10 MB |
| Requests per file | 1 GET, 1 PUT, 1 HEAD, 1 DELETE | `src/app.mjs` |

Cold starts are left out: at a steady ~385 concurrent executions, containers stay warm.
The on-prem exporter's own PUTs (730M × $0.005/1,000 ≈ $3,650) are left out too, because
they exist with or without this feature.

### Monthly cost of running the feature

| Item | Calculation | USD/month |
|---|---|---|
| Lambda compute | 730M × 1.38 s × 0.5 GB × $0.0000133334/GB-s | 6,732 |
| Lambda requests | 730M × $0.20/1M | 146 |
| S3 GET (download original) | 730M × $0.004/10,000 | 292 |
| S3 HEAD (verify zip) | 730M × $0.004/10,000 | 292 |
| S3 PUT (upload zip) | 730M × $0.005/1,000 | 3,650 |
| S3 DELETE | free | 0 |
| CloudWatch Logs | ~500 bytes per run = 365 GB × $0.70 ingest + $0.03/GB-month storage | 261 |
| Network: S3 via Gateway Endpoint, same region | free | 0 |
| **Total** | | **≈ 11,400** |

### Final monthly figure

The brief gives the volume and average size only, so this is the bill for **the first full
month** of running the feature. Files arrive evenly across the month, and S3 bills storage
by the average stored, so month 1 pays for about half of the month's data.

| Month 1 | Without the feature | With the feature |
|---|---|---|
| Pipeline (table above) | 0 | 11,373 |
| S3 Standard storage (average 3.65 PB raw vs 358 TB zipped) | 84,500 | 8,639 |
| **Total (USD)** | **84,500** | **≈ 20,000** |

**Final figure: about $20,000 for the month, against $84,500 without the feature**, a
saving of about $64,500. From month 2 onwards the gap widens, because each month's zips
cost $17,013/month to store where the raw JSON would cost $168,450/month.

### Choosing the Lambda memory size

Lambda allocates CPU in proportion to memory, and compression is CPU-bound, so lower
memory runs longer. I benchmarked the deployed function in ap-southeast-1 with the same
file at four sizes (average of two warm runs each, scaled to 10 MB):

| Memory | Duration per 10 MB file | GB-seconds per file | Compute USD/month | Concurrent executions |
|---|---|---|---|---|
| 256 MB | 2.89 s | 0.72 | 7,036 | ~800 |
| **512 MB** | **1.38 s** | **0.69** | **6,732** | **~385** |
| 1024 MB | 0.86 s | 0.86 | 8,337 | ~240 |
| 1769 MB | 0.55 s | 0.95 | 9,220 | ~150 |

Peak memory was ~190 MB at every size. To check headroom, because 10 MB is an *average*, I
also ran larger files:

| File size | 256 MB | 512 MB |
|---|---|---|
| 25 MB | 8.1 s | 4.0 s |
| 50 MB | 13.8 s | 6.8 s |
| 80 MB | **failed** | 9.3 s |

The template uses **512 MB**: the cheapest per file in this run, 19% cheaper than 1024 MB,
and it handles 80 MB files. 256 MB costs about the same (it runs twice as long), fails on
large files, and would need ~800 concurrent executions against the default account limit of
1,000.

### Suggestions to save more

1. **Move zips to S3 Glacier Instant Retrieval after 30 days** with a lifecycle rule:
   $0.005 instead of $0.023 per GB-month, which takes one month of zips from $17,013 to
   $3,579/month. It saves nothing in month 1, because nothing is 30 days old yet. The
   transition fee is $0.02 per 1,000 objects ($14,600 for one month of per-file zips) and is
   repaid after about five weeks. Glacier IR also charges a 90-day minimum and $0.03/GB on
   every read, so it fits data that is rarely read after the first month.
2. **Batch files per archive** (S3 → SQS → Lambda with a 5-minute batching window). Compute
   stays the same, because it scales with bytes processed, not with invocations. PUT and HEAD
   requests drop from $3,942 to ~$4, Lambda requests from $146 to ~$0, and SQS adds ~$350:
   **about $3,700/month saved**. Fewer, larger objects also make the Glacier transition fee
   in (1) negligible. It changes the
   design from one zip per object (what Task 1 asks for), needs an index to find a file inside
   a bundle, and needs partial-batch failure handling. ZIP compresses each entry separately,
   so bundling does not improve the compression ratio.
3. **Tune the compression level.** Compute is ~59% of the running cost. zlib level 1 is much
   faster than level 6 at a slightly larger output. Worth benchmarking against the storage
   cost of the bigger files before changing it.
4. **Compute Savings Plan.** Up to 17% off Lambda compute (~$1,100/month) for a 1- or 3-year
   commitment.
5. **Set a log retention period** (for example 14 days). Without one, CloudWatch keeps the
   365 GB/month of logs forever.

## Task 5: Scalability and bottlenecks

TODO
