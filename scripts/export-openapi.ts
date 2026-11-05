// Writes the OpenAPI spec to openapi.json (the frontend generates its API types from it).
import { writeFileSync } from "node:fs";
import { buildOpenApiDocument } from "../src/openapi.js";
import { VERSION } from "../src/version.js";

writeFileSync("openapi.json", JSON.stringify(buildOpenApiDocument(VERSION), null, 2) + "\n");
console.log("Wrote openapi.json");
