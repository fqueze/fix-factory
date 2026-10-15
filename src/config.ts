import { readFileSync } from "node:fs";
import type { FactoryConfig } from "./types.ts";

export function loadConfig(path = process.env.FACTORY_CONFIG ?? "factory.config.json"): FactoryConfig {
  return JSON.parse(readFileSync(path, "utf8")) as FactoryConfig;
}
