export interface EvaluationResult {
  key: string;
  source: string;
  reference: string;
  hypothesis: string;
  score: number;
}

export interface EvaluationSummary {
  totalKeys: number;
  averageScore: number;
  lowQualityCount: number;
  lowQuality: EvaluationResult[];
  results: EvaluationResult[];
}

export interface ScoringStrategy {
  computeScore(
    source: string,
    reference: string,
    hypothesis: string
  ): Promise<number>;

  computeBatchScores(
    segments: Array<{ source: string; reference: string; hypothesis: string }>
  ): Promise<number[]>;

  compareSystems(
    segments: Array<{
      source: string;
      reference: string;
      hypotheses: Record<string, string>;
    }>
  ): Promise<ComparisonResult>;
}

export interface SystemScore {
  scores: number[];
  systemScore: number;
}

export interface PairwiseComparison {
  system1: string;
  system2: string;
  winner: string | null;
  diff: number;
}

export interface ComparisonResult {
  systems: Record<string, SystemScore>;
  ranking: Array<{ system: string; score: number }>;
  pairwise: PairwiseComparison[];
}

export interface ComparisonSummary {
  totalKeys: number;
  systems: Record<string, EvaluationSummary>;
  ranking: Array<{ system: string; score: number }>;
  pairwise: PairwiseComparison[];
}
