from pathlib import Path
import subprocess
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CompareModelSyncTests(unittest.TestCase):
    def setUp(self):
        self.source = (ROOT / "web/js/compare.js").read_text(encoding="utf-8")

    def test_delayed_model_preference_refreshes_existing_column_header(self):
        open_compare = self.source.split("async function openCompare(){", 1)[1].split(
            "function closeCompare()", 1
        )[0]
        preference_refresh = open_compare.split('api("/api/model-pref")', 1)[1]

        self.assertIn("CMP.modelPrefs=mp.prefs||{}", preference_refresh)
        self.assertIn("cmpRefreshModelControls()", preference_refresh)

    def test_header_refresh_preserves_column_messages(self):
        refresh = self.source.split("function cmpRefreshModelControls(providers=null){", 1)[
            1
        ].split("async function cmpEnsureProviderThread", 1)[0]

        self.assertIn('const model=cmpSelectedModelId(p.id)||"auto"', refresh)
        self.assertIn("sel.value=model", refresh)
        self.assertIn("input.value=model", refresh)
        self.assertNotIn("innerHTML=", refresh)
        self.assertNotIn("remove()", refresh)

    def test_header_and_request_share_the_same_selected_model_helper(self):
        self.assertGreaterEqual(self.source.count("cmpSelectedModelId("), 4)
        self.assertIn("const cur=cmpSelectedModelId(p.id)||\"auto\"", self.source)
        self.assertIn("const id=cmpSelectedModelId(prov)", self.source)

    def test_refresh_changes_pro_to_saved_flash_without_rebuilding_column(self):
        module_uri = (ROOT / "web/js/compare.js").as_uri()
        script = textwrap.dedent(
            f"""
            globalThis.localStorage={{getItem:()=>null,setItem:()=>{{}}}};
            globalThis.window={{}};
            globalThis.PROVIDERS=[{{id:"deepseek",name:"DeepSeek"}}];
            globalThis.document={{activeElement:null,createElement:()=>({{value:"",textContent:""}})}};
            globalThis.requestAnimationFrame=()=>0;
            const message={{text:"existing answer"}};
            const select={{
              value:"deepseek-v4-pro",
              options:[{{value:"deepseek-v4-pro"}},{{value:"deepseek-v4-flash"}}],
              appendChild(option){{this.options.push(option);}}
            }};
            const column={{
              message,
              querySelector(selector){{return selector===".cmpmodelsel"?select:null;}}
            }};
            const box={{
              querySelector(selector){{return selector.includes('deepseek')?column:null;}}
            }};
            globalThis.$=selector=>selector==="#cmpCols"?box:null;
            const mod=await import("{module_uri}");
            mod.CMP.modelPrefs={{deepseek:"deepseek-v4-flash"}};
            mod.cmpRefreshModelControls();
            if(select.value!=="deepseek-v4-flash") throw new Error("stale model badge");
            if(column.message!==message) throw new Error("column rebuilt");
            """
        )
        subprocess.run(
            ["node", "--input-type=module", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )


if __name__ == "__main__":
    unittest.main()
