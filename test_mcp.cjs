const { spawn } = require("child_process");
const http = require("http");

const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const pendingRequests = new Map();

function postMessage(urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const url = new URL(urlPath, BASE_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`POST ${urlPath} failed with status ${res.statusCode}: ${body}`));
          } else {
            resolve(body);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendRpcRequest(endpoint, method, params = {}, id) {
  const promise = new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
  });
  
  postMessage(endpoint, {
    jsonrpc: "2.0",
    id,
    method,
    params
  }).catch((err) => {
    const pending = pendingRequests.get(id);
    if (pending) {
      pending.reject(err);
      pendingRequests.delete(id);
    }
  });

  return promise;
}

function connectSse() {
  return new Promise((resolve, reject) => {
    const url = new URL("/sse?apiKey=test-secret-key", BASE_URL);
    console.log(`Connecting to SSE: ${url.href}`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Accept: "text/event-stream",
        },
      },
      (res) => {
        let buffer = "";
        let endpoint = null;
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          buffer += chunk;
          let blockEnd;
          while ((blockEnd = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.substring(0, blockEnd);
            buffer = buffer.substring(blockEnd + 2);

            let eventName = "message";
            let dataStr = "";

            const lines = block.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith("event:")) {
                eventName = trimmed.substring(6).trim();
              } else if (trimmed.startsWith("data:")) {
                dataStr = trimmed.substring(5).trim();
              }
            }

            if (eventName === "endpoint") {
              endpoint = dataStr;
              resolve({ endpoint, res });
            } else if (eventName === "message") {
              try {
                const payload = JSON.parse(dataStr);
                console.log(`[SSE Message Received]:`, JSON.stringify(payload));
                if (payload.id !== undefined && pendingRequests.has(payload.id)) {
                  const { resolve: resFn } = pendingRequests.get(payload.id);
                  pendingRequests.delete(payload.id);
                  resFn(payload);
                }
              } catch (e) {
                console.error("Failed to parse SSE message data:", e);
              }
            }
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  console.log("Starting MCP Server for Integration Testing...");
  const serverProc = spawn("node", ["dist/index.js"], {
    env: {
      ...process.env,
      MCP_PORT: PORT.toString(),
      MCP_BASE_URL: `http://localhost/sites`,
      MCP_DATA_DIR: "./test_data",
      MCP_API_KEY: "test-secret-key",
      MCP_CLEANUP_INTERVAL: "1000",
    },
    shell: false,
  });

  serverProc.stdout.on("data", (data) => {
    console.log(`[Server STDOUT]: ${data.toString().trim()}`);
  });

  serverProc.stderr.on("data", (data) => {
    console.error(`[Server STDERR]: ${data.toString().trim()}`);
  });

  let healthy = false;
  for (let i = 0; i < 15; i++) {
    await delay(1000);
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${BASE_URL}/health`, (res) => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`Status: ${res.statusCode}`));
        });
        req.on("error", reject);
      });
      healthy = true;
      console.log("Server is healthy!");
      break;
    } catch (err) {
      console.log(`Waiting for server to start... (${i + 1}/15)`);
    }
  }

  if (!healthy) {
    console.error("Server failed to start or pass health check.");
    serverProc.kill();
    process.exit(1);
  }

  let sseConnection;
  try {
    // --- Verify API key authentication is working ---
    console.log("\n--- Testing API Key Rejection ---");
    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "localhost",
          port: PORT,
          path: "/sse",
          method: "GET",
        },
        (res) => {
          if (res.statusCode === 401) {
            console.log("Success: Request without API key got 401 Unauthorized.");
            resolve();
          } else {
            reject(new Error(`Expected 401 Unauthorized, got ${res.statusCode}`));
          }
        }
      );
      req.on("error", reject);
      req.end();
    });

    const sseResult = await connectSse();
    const endpoint = sseResult.endpoint;
    sseConnection = sseResult.res;
    console.log(`Connected. Post endpoint: ${endpoint}`);

    console.log("\n--- Sending Initialize Request ---");
    const initResponse = await sendRpcRequest(endpoint, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    }, 1);
    console.log("Initialize Response matches ID 1:", JSON.stringify(initResponse, null, 2));

    await postMessage(endpoint, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    console.log("Sent initialized notification.");

    console.log("\n--- Listing Tools ---");
    const listToolsRes = await sendRpcRequest(endpoint, "tools/list", {}, 2);
    console.log("Available tools:");
    for (const tool of listToolsRes.result.tools) {
      console.log(` - ${tool.name}: ${tool.description}`);
    }

    console.log("\n--- Testing deploy_site tool ---");
    const htmlContentBase64 = Buffer.from("<h1>Hello world from integration test</h1>").toString("base64");
    const deployRes = await sendRpcRequest(endpoint, "tools/call", {
      name: "deploy_site",
      arguments: {
        name: "test-hello-world",
        files: [
          {
            path: "index.html",
            content: htmlContentBase64,
          },
        ],
      },
    }, 3);
    console.log("Deploy Result:", JSON.stringify(deployRes.result, null, 2));
    const resultObj = JSON.parse(deployRes.result.content[0].text);
    const siteId = resultObj.site_id;
    console.log(`Deployed site with ID: ${siteId}`);

    console.log("\n--- Testing list_sites tool ---");
    const listSitesRes = await sendRpcRequest(endpoint, "tools/call", {
      name: "list_sites",
      arguments: {},
    }, 4);
    console.log("List Sites Result:", JSON.stringify(listSitesRes.result, null, 2));

    console.log("\n--- Testing update_site tool ---");
    const updatedHtmlBase64 = Buffer.from("<h1>Hello world UPDATED!</h1>").toString("base64");
    const updateRes = await sendRpcRequest(endpoint, "tools/call", {
      name: "update_site",
      arguments: {
        site_id: siteId,
        files: [
          {
            path: "index.html",
            content: updatedHtmlBase64,
          },
        ],
      },
    }, 5);
    console.log("Update Result:", JSON.stringify(updateRes.result, null, 2));

    console.log("\n--- Testing delete_site tool ---");
    const deleteRes = await sendRpcRequest(endpoint, "tools/call", {
      name: "delete_site",
      arguments: {
        site_id: siteId,
      },
    }, 6);
    console.log("Delete Result:", JSON.stringify(deleteRes.result, null, 2));

    console.log("\n--- Testing site TTL / Expiration cleanup ---");
    const ttlHtmlBase64 = Buffer.from("<h1>TTL site</h1>").toString("base64");
    const ttlDeployRes = await sendRpcRequest(endpoint, "tools/call", {
      name: "deploy_site",
      arguments: {
        name: "test-ttl-expiry",
        ttl: 2, // 2 seconds
        files: [
          {
            path: "index.html",
            content: ttlHtmlBase64,
          },
        ],
      },
    }, 7);
    console.log("TTL Deploy Result:", JSON.stringify(ttlDeployRes.result, null, 2));
    const ttlResultObj = JSON.parse(ttlDeployRes.result.content[0].text);
    const ttlSiteId = ttlResultObj.site_id;
    console.log(`Deployed TTL site with ID: ${ttlSiteId}. Expires at: ${ttlResultObj.expires_at}`);

    // Verify it is in list
    const ttlListBefore = await sendRpcRequest(endpoint, "tools/call", {
      name: "list_sites",
      arguments: { keyword: ttlSiteId },
    }, 8);
    const ttlListBeforeObj = JSON.parse(ttlListBefore.result.content[0].text);
    if (ttlListBeforeObj.total !== 1) {
      throw new Error(`Expected TTL site to be visible before expiration, but got total ${ttlListBeforeObj.total}`);
    }
    console.log("Site is successfully listed before expiration.");

    console.log("Waiting 3.5 seconds for expiration and cleanup...");
    await delay(3500);

    // Verify it is gone
    const ttlListAfter = await sendRpcRequest(endpoint, "tools/call", {
      name: "list_sites",
      arguments: { keyword: ttlSiteId },
    }, 9);
    const ttlListAfterObj = JSON.parse(ttlListAfter.result.content[0].text);
    if (ttlListAfterObj.total !== 0) {
      throw new Error(`Expected TTL site to be deleted, but it is still in list!`);
    }
    console.log("Success! Site was automatically deleted after expiration.");

    console.log("\nAll integration tests passed successfully!");
  } catch (err) {
    console.error("Test failed with error:", err);
    process.exitCode = 1;
  } finally {
    if (sseConnection) {
      sseConnection.destroy();
    }
    console.log("Stopping MCP Server...");
    serverProc.kill("SIGTERM");
  }
}

main();
