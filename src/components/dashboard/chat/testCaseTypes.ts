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

export interface TestModelClass {
  id: string;
  name: string;
  isBoundary?: boolean;
}

export interface TestModelDimension {
  name: string;
  aspect: string;
  classes: TestModelClass[];
}

export interface TestModelCombination {
  id: string;
  classRefs: string[];
  priority: string;
  rationale?: string;
}

export interface TestModel {
  dimensions: TestModelDimension[];
  combinations: TestModelCombination[];
}

export interface TestCaseJudgeCriterion {
  name: string;
  passed: boolean;
  score?: number;
  evidence?: string;
  missing?: string[];
}

export interface TestCaseJudge {
  passed: boolean;
  criteria: TestCaseJudgeCriterion[];
  feedback: string;
  skipped?: boolean;
  reason?: string;
}

export interface TestCaseGenerationRound {
  round: number;
  heuristicPassed: boolean;
  judgePassed: boolean | null;
  judgeSkipped?: boolean;
  failedCriteria: string[];
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
  judge?: TestCaseJudge;
  generationRounds?: number;
  history?: TestCaseGenerationRound[];
  testModel?: TestModel;
  modelCoveragePct?: number | null;
  similarCases: TestCaseSimilarCase[];
  generatedAt: string;
}
