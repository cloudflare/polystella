import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ScoringStrategy, ComparisonResult } from '../types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class CometScoringStrategy implements ScoringStrategy {
  private pythonScript: string;

  constructor() {
    this.pythonScript = join(__dirname, 'comet_score.py');
  }

  async computeScore(
    source: string,
    reference: string,
    hypothesis: string
  ): Promise<number> {
    const scores = await this.computeBatchScores([
      { source, reference, hypothesis }
    ]);
    return scores[0];
  }

  async computeBatchScores(
    segments: Array<{ source: string; reference: string; hypothesis: string }>
  ): Promise<number[]> {
    const input = segments.map((seg) => ({
      src: seg.source,
      mt: seg.hypothesis,
      ref: seg.reference
    }));

    return new Promise((resolve, reject) => {
      const python = spawn('python3', [this.pythonScript]);

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        if (code !== 0) {
          try {
            const errorData = JSON.parse(stderr);
            reject(new Error(`COMET scoring failed: ${errorData.error}`));
          } catch {
            reject(
              new Error(`COMET scoring failed: ${stderr || 'Unknown error'}`)
            );
          }
          return;
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result.scores);
        } catch (error) {
          if (error instanceof Error) {
            reject(new Error(`Failed to parse COMET output: ${error.message}`));
          } else {
            reject(error);
          }
        }
      });

      python.on('error', (error) => {
        reject(new Error(`Failed to run COMET scorer: ${error.message}`));
      });

      // Write JSON to stdin and close
      python.stdin.write(JSON.stringify(input));
      python.stdin.end();
    });
  }

  async compareSystems(
    segments: Array<{
      source: string;
      reference: string;
      hypotheses: Record<string, string>;
    }>
  ): Promise<ComparisonResult> {
    const sources = segments.map((seg) => seg.source);
    const references = segments.map((seg) => seg.reference);

    const systemNames = Object.keys(segments[0].hypotheses);
    const systems: Record<string, string[]> = {};

    for (const systemName of systemNames) {
      systems[systemName] = segments.map((seg) => seg.hypotheses[systemName]);
    }

    const input = {
      mode: 'compare',
      sources,
      references,
      systems
    };

    return new Promise((resolve, reject) => {
      const python = spawn('python3', [this.pythonScript]);

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        if (code !== 0) {
          try {
            const errorData = JSON.parse(stderr);
            reject(new Error(`COMET comparison failed: ${errorData.error}`));
          } catch {
            reject(
              new Error(`COMET comparison failed: ${stderr || 'Unknown error'}`)
            );
          }
          return;
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (error) {
          if (error instanceof Error) {
            reject(new Error(`Failed to parse COMET output: ${error.message}`));
          } else {
            reject(error);
          }
        }
      });

      python.on('error', (error) => {
        reject(new Error(`Failed to run COMET scorer: ${error.message}`));
      });

      python.stdin.write(JSON.stringify(input));
      python.stdin.end();
    });
  }
}
