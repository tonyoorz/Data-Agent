export interface TestCaseVerificationCriterion {
  name: string;
  passed: boolean;
  evidence: string;
}

export interface TestCaseVerification {
  passed: boolean;
  criteria: TestCaseVerificationCriterion[];
  feedback: string;
}

export interface TestCaseSimilarCase {
  testId: string;
  name: string;
  score: number;
}

export interface TestCaseResult {
  defectId: string;
  defectName: string;
  defectSeverity: string;
  defectSoftwareVersion?: string;
  defectAssignedEcu?: string;
  defectLeadModel?: string;
  name: string;
  descriptionHtml: string;
  stepsText: string;
  verification: TestCaseVerification;
  similarCases: TestCaseSimilarCase[];
  generatedAt: string;
}
