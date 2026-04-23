export interface TestCase {
  id: string;
  category: string;
  input: string;
  history?: { role: "user" | "assistant"; content: string }[];
  expected_tools?: string[];
  expected_intent?: string;
  must_contain?: string[];
  must_contain_any?: string[];
  must_not_contain?: string[];
  must_contain_tag?: boolean;
  must_not_contain_tag?: boolean;
  notes?: string;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface CaseResult {
  id: string;
  category: string;
  input: string;
  response: string;
  latencyMs: number;
  toolCalls: string[];
  detectedIntent: string;
  assertions: AssertionResult[];
  judgeScore?: number;
  judgeRationale?: string;
  passed: boolean;
  error?: string;
}

export interface EvalReport {
  ts: string;
  totalCases: number;
  passed: number;
  failed: number;
  byCategory: Record<string, { passed: number; failed: number }>;
  cases: CaseResult[];
}
