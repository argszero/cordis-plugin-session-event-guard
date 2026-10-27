/**
 * Rendering. The report is the artifact a plugin author reads, so it states
 * the two write paths as measurements, and quotes a reader's refusal verbatim
 * rather than summarizing it — the refusal's own wording carries the type name
 * and sequence the reader stopped at.
 *
 * @module @argszero/cordis-plugin-session-event-guard/report
 */
import type { WriteVerdict } from './classify.ts';
import type { SessionAudit } from './audit.ts';
import type { SourceOffence, SourceVerdict } from './source-kind.ts';
import type { VocabularyReport } from './vocabulary.ts';
/**
 * Render the write-boundary verdict.
 * @param verdict - the verdict from {@link writeVerdict}.
 * @param vocabulary - which build answered.
 * @returns the report text.
 */
export declare function renderWriteVerdict(verdict: WriteVerdict, vocabulary: VocabularyReport): string;
/**
 * Render the producer-owned source verdict.
 * @param verdict - the verdict from {@link sourceVerdict}.
 * @returns the report text.
 */
export declare function renderSourceVerdict(verdict: SourceVerdict): string;
/**
 * Render the live producer-owned-source ledger.
 * @param live - per-session offences observed in this process.
 * @returns the section text.
 */
export declare function renderLiveSources(live: {
    id: string;
    offences: (SourceOffence & {
        count: number;
    })[];
}[]): string;
/**
 * Render one session audit section.
 * @param audit - the audit for one stored session.
 * @returns the section text.
 */
export declare function renderSessionAudit(audit: SessionAudit): string;
/**
 * Render the store-wide audit, disclosing how much of the store was opened.
 * @param audits - the per-session audits.
 * @param total - how many stored sessions exist.
 * @returns the report text.
 */
export declare function renderStoreAudit(audits: SessionAudit[], total: number): string;
//# sourceMappingURL=report.d.ts.map