# Official Lambda Node.js base image. Includes the Runtime Interface Client.
FROM public.ecr.aws/lambda/nodejs:22

# Copy the lockfile too, and use npm ci, so every build installs the exact same versions.
COPY package.json package-lock.json ${LAMBDA_TASK_ROOT}/
RUN npm ci --omit=dev

COPY app.mjs ${LAMBDA_TASK_ROOT}/

# handler = <file>.<exported function>
CMD ["app.lambdaHandler"]
