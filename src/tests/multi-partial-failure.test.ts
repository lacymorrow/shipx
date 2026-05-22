import { describe, expect, test } from "bun:test";
import { classifyPipelineFailure, type PipelineState } from "../multi.ts";

describe("classifyPipelineFailure", () => {
	test("nothing done → no rollback needed, cannot publish", () => {
		const state: PipelineState = {
			didBump: false,
			didCommit: false,
			didPush: false,
			didComputeBumpedFiles: false,
			bumpedFiles: [],
		};
		const result = classifyPipelineFailure(state);
		expect(result.needsRollback).toBe(false);
		expect(result.canContinueToPublish).toBe(false);
		expect(result.partialStateWarning).toBe("");
	});

	test("bumped but not committed → needs rollback, cannot publish", () => {
		const state: PipelineState = {
			didBump: true,
			didCommit: false,
			didPush: false,
			didComputeBumpedFiles: true,
			bumpedFiles: ["package.json"],
		};
		const result = classifyPipelineFailure(state);
		expect(result.needsRollback).toBe(true);
		expect(result.canContinueToPublish).toBe(false);
		expect(result.partialStateWarning).toContain("bumped");
	});

	test("committed but not pushed → needs rollback, cannot publish", () => {
		const state: PipelineState = {
			didBump: true,
			didCommit: true,
			didPush: false,
			didComputeBumpedFiles: true,
			bumpedFiles: ["package.json"],
		};
		const result = classifyPipelineFailure(state);
		expect(result.needsRollback).toBe(true);
		expect(result.canContinueToPublish).toBe(false);
		expect(result.partialStateWarning).toContain("local");
	});

	test("pushed → no rollback needed, CAN continue to publish", () => {
		const state: PipelineState = {
			didBump: true,
			didCommit: true,
			didPush: true,
			didComputeBumpedFiles: true,
			bumpedFiles: ["package.json"],
		};
		const result = classifyPipelineFailure(state);
		expect(result.needsRollback).toBe(false);
		expect(result.canContinueToPublish).toBe(true);
	});

	test("partial state warning includes 'remote' when pushed", () => {
		const state: PipelineState = {
			didBump: true,
			didCommit: true,
			didPush: true,
			didComputeBumpedFiles: true,
			bumpedFiles: ["package.json"],
		};
		const result = classifyPipelineFailure(state);
		expect(result.partialStateWarning).toContain("remote");
	});

	test("commit without bump (unusual) → still needs rollback", () => {
		const state: PipelineState = {
			didBump: false,
			didCommit: true,
			didPush: false,
			didComputeBumpedFiles: false,
			bumpedFiles: [],
		};
		const result = classifyPipelineFailure(state);
		expect(result.needsRollback).toBe(true);
	});
});
