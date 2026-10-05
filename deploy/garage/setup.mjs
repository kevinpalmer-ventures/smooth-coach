// Idempotent Garage setup for Smooth Coach: node layout, app key, bucket, and grant.
// Targets the Garage admin API v2 as shipped in Garage v2.4.1. Never logs secrets.

export const setupVariables = ["GARAGE_ADMIN_TOKEN", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];

export function missingSetupVariables(env) {
  return setupVariables.filter((name) => !env[name]);
}

export function parseCapacity(value) {
  const match = /^(\d+)\s*([KMGT]?)B?$/i.exec(String(value).trim());
  if (!match || Number(match[1]) === 0) throw new Error("GARAGE_CAPACITY must look like 10G, 500M, or 1T");
  const power = { "": 0, K: 1, M: 2, G: 3, T: 4 }[match[2].toUpperCase()];
  return Number(match[1]) * 1000 ** power;
}

export async function runSetup({ adminUrl, adminToken, bucket, accessKeyId, secretAccessKey, capacity = "10G", log = console.log, retries = 30, retryDelayMs = 2000 }) {
  const capacityBytes = parseCapacity(capacity);

  async function admin(method, endpoint, { query, body, allowMissing = false } = {}) {
    const url = new URL(endpoint, adminUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${adminToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    // Garage answers lookups of unknown keys and buckets with 400 or 404.
    if (allowMissing && (response.status === 404 || response.status === 400)) return null;
    if (!response.ok) throw new Error(`${method} ${endpoint} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function waitForGarage() {
    let lastError = "no response";
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const status = await admin("GET", "/v2/GetClusterStatus");
        if (status?.nodes?.length) return status;
        lastError = "cluster status listed no nodes";
      } catch (error) {
        lastError = error.cause?.code ?? error.message;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    throw new Error(`Garage admin API at ${adminUrl} did not become ready (last error: ${lastError})`);
  }

  const status = await waitForGarage();

  const layout = await admin("GET", "/v2/GetClusterLayout");
  if (layout.roles.length > 0) {
    log(`garage-init: layout already applied (version ${layout.version})`);
  } else {
    await admin("POST", "/v2/UpdateClusterLayout", { body: { roles: [{ id: status.nodes[0].id, zone: "dc1", capacity: capacityBytes, tags: [] }] } });
    await admin("POST", "/v2/ApplyClusterLayout", { body: { version: layout.version + 1 } });
    log(`garage-init: assigned node with ${capacity} capacity and applied layout version ${layout.version + 1}`);
  }

  if (await admin("GET", "/v2/GetKeyInfo", { query: { id: accessKeyId }, allowMissing: true })) {
    log("garage-init: app key already exists");
  } else {
    await admin("POST", "/v2/ImportKey", { body: { accessKeyId, secretAccessKey, name: "smooth-coach-app" } });
    log("garage-init: imported app key");
  }

  let bucketInfo = await admin("GET", "/v2/GetBucketInfo", { query: { globalAlias: bucket }, allowMissing: true });
  if (bucketInfo) {
    log(`garage-init: bucket ${bucket} already exists`);
  } else {
    bucketInfo = await admin("POST", "/v2/CreateBucket", { body: { globalAlias: bucket } });
    log(`garage-init: created bucket ${bucket}`);
  }

  const permissions = bucketInfo.keys?.find((key) => key.accessKeyId === accessKeyId)?.permissions;
  if (permissions?.read && permissions?.write) {
    log("garage-init: app key already has read/write on the bucket");
  } else {
    await admin("POST", "/v2/AllowBucketKey", { body: { bucketId: bucketInfo.id, accessKeyId, permissions: { read: true, write: true, owner: false } } });
    log("garage-init: granted app key read/write on the bucket");
  }
  log("garage-init: done");
}
