from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CompareSummaryLayoutTests(unittest.TestCase):
    def setUp(self):
        self.html = (ROOT / "web/index.html").read_text(encoding="utf-8")
        self.css = (ROOT / "web/css/compare.css").read_text(encoding="utf-8")
        self.js = (ROOT / "web/js/compare.js").read_text(encoding="utf-8")

    def test_toolbar_exposes_stacked_and_summary_layouts(self):
        self.assertIn('data-l="stack"', self.html)
        self.assertIn('data-l="summary"', self.html)
        self.assertIn('id="cmpSummary"', self.html)
        self.assertIn('"stack","summary"', self.js)
        self.assertIn('box.classList.add("lay-stack")', self.js)
        self.assertIn('box.classList.add("lay-summary")', self.js)

    def test_stacked_layout_uses_full_width_model_rows(self):
        self.assertIn("#cmpCols.lay-stack{flex-direction:column", self.css)
        self.assertIn("#cmpCols.lay-stack .cmpcol", self.css)
        self.assertIn("width:100%", self.css)

    def test_summary_only_pairs_answers_after_the_latest_question(self):
        self.assertIn("function cmpSummaryPair(prov)", self.js)
        self.assertIn("const start=userIndex>=0?userIndex+1:0", self.js)
        self.assertIn("for(let i=records.length-1;i>=start;i--)", self.js)
        self.assertIn('records[i].kind==="agent_message"', self.js)
        self.assertIn("latestPrompt:{}", self.js)

    def test_summary_covers_selected_models_and_restored_briefs(self):
        self.assertIn("PROVIDERS.filter(p=>CMP.sel.has(p.id))", self.js)
        self.assertIn("function cmpHydrateSummary()", self.js)
        self.assertIn("cmpLoadBrief(p.id,pair.threadId)", self.js)
        self.assertIn("cmpScheduleSummaryRender()", self.js)
        self.assertIn("cmpRenderSummary(); cmpHydrateSummary();", self.js)

    def test_summary_answers_keep_copy_and_context_actions(self):
        self.assertIn('card.className="cmpsum-card msg assistant"', self.js)
        self.assertIn('answer.className="cmpsum-answer content"', self.js)
        self.assertIn('card._cwRawMessage=()=>pair.answer', self.js)
        self.assertIn('card._cwInputSel="#cmpInput"', self.js)

    def test_summary_is_responsive(self):
        self.assertIn(".cmpsum-grid{display:grid;grid-template-columns:minmax(0,1fr)", self.css)
        self.assertNotIn("repeat(2,minmax(0,1fr))", self.css)

    def test_summary_questions_are_visually_secondary(self):
        self.assertIn(
            ".cmpsum-question .cmpsum-text,.cmpsum-card-question .cmpsum-text"
            "{color:var(--ink-2);font-size:12px",
            self.css,
        )


if __name__ == "__main__":
    unittest.main()
