import { test } from "node:test";
import assert from "node:assert";
import { handleMcp, serveMcp } from "./mcp.js";
import { checkBudget } from "./check.js";

// Mock the checkBudget function to avoid actual file reading
test("handleMcp - initialize method", () => {
  const message = { jsonrpc: "2.0", id: 1, method: "initialize" };
  const result = handleMcp(message, {});
  
  assert.deepEqual(result, {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "costcap", version: "0.0.1" },
      instructions: "Read-only estimated budget status for the configured local receipt ledger. Not a billing guarantee."
    }
  });
});

test("handleMcp - ping method", () => {
  const message = { jsonrpc: "2.0", id: 2, method: "ping" };
  const result = handleMcp(message, {});
  
  assert.deepEqual(result, {
    jsonrpc: "2.0",
    id: 2,
    result: {}
  });
});

test("handleMcp - tools/list method", () => {
  const message = { jsonrpc: "2.0", id: 3, method: "tools/list" };
  const result = handleMcp(message, {});
  
  assert.deepEqual(result, {
    jsonrpc: "2.0",
    id: 3,
    result: {
      tools: [{
        name: "budget_status",
        description: "Read configured local receipts and estimated spend. Cannot change caps or authorize paid calls.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      }]
    }
  });
});

test("handleMcp - tools/call with budget_status", () => {
  // Mock checkBudget to return a predictable result
  const originalCheckBudget = checkBudget;
  checkBudget = () => ({ run: 100, day: 50, month: 200, unknown: 5 });
  
  try {
    const message = { 
      jsonrpc: "2.0", 
      id: 4, 
      method: "tools/call", 
      params: { name: "budget_status" } 
    };
    const result = handleMcp(message, {});
    
    assert.ok(result);
    assert.equal(result.jsonrpc, "2.0");
    assert.equal(result.id, 4);
    assert.ok(result.result.content);
    assert.ok(result.result.content[0]);
    assert.equal(result.result.content[0].type, "text");
    assert.ok(result.result.content[0].text);
    assert.equal(result.result.isError, false);
  } finally {
    // Restore original function
    checkBudget = originalCheckBudget;
  }
});

test("handleMcp - tools/call with budget_status error", () => {
  // Mock checkBudget to throw an error
  const originalCheckBudget = checkBudget;
  checkBudget = () => { throw new Error("Test error"); };
  
  try {
    const message = { 
      jsonrpc: "2.0", 
      id: 5, 
      method: "tools/call", 
      params: { name: "budget_status" } 
    };
    const result = handleMcp(message, {});
    
    assert.ok(result);
    assert.equal(result.jsonrpc, "2.0");
    assert.equal(result.id, 5);
    assert.ok(result.result.content);
    assert.ok(result.result.content[0]);
    assert.equal(result.result.content[0].type, "text");
    assert.ok(result.result.content[0].text);
    assert.equal(result.result.isError, true);
  } finally {
    // Restore original function
    checkBudget = originalCheckBudget;
  }
});

test("handleMcp - invalid request", () => {
  const message = { jsonrpc: "1.0", id: 6, method: "initialize" };
  const result = handleMcp(message, {});
  
  assert.deepEqual(result, {
    jsonrpc: "2.0",
    id: 6,
    error: { code: -32600, message: "Invalid request" }
  });
});

test("handleMcp - method not found", () => {
  const message = { jsonrpc: "2.0", id: 7, method: "unknown_method" };
  const result = handleMcp(message, {});
  
  assert.deepEqual(result, {
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32601, message: "Method not found" }
  });
});

test("handleMcp - no id", () => {
  const message = { jsonrpc: "2.0", method: "ping" };
  const result = handleMcp(message, {});
  
  assert.equal(result, null);
});

test("serveMcp - basic functionality", () => {
  // This test just verifies that the function can be called
  // without actually processing input since that would require
  // stdin mocking which is complex in this environment
  const lines = serveMcp({});
  assert.ok(lines);
});
