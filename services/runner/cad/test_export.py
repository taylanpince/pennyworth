import json
import tempfile
import unittest
from pathlib import Path
from export import export_model


class ExportTest(unittest.TestCase):
    def test_revisions_and_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, out = root / "model.py", root / "out"
            source.write_text('from build123d import Box\nparameters = {"length": 10}\nresult = Box(10, 20, 3)\n')
            first = export_model(source, "bracket", out)
            saved = {p.name: p.read_bytes() for p in out.iterdir()}
            self.assertEqual(first["checks"]["bounds_mm"], (10, 20, 3))
            self.assertAlmostEqual(first["checks"]["volume_mm3"], 600)
            source.write_text('from build123d import Box\nresult = Box(30, 20, 3)\n')
            second = export_model(source, "bracket", out)
            self.assertEqual(second["revision"], 2)
            self.assertEqual(len(list(out.iterdir())), 10)
            for name, content in saved.items():
                self.assertEqual((out / name).read_bytes(), content)
            self.assertEqual((out / "bracket-v002.py").read_text(), source.read_text())
            self.assertTrue(json.loads((out / "bracket-v002.json").read_text())["checks"]["step_round_trip"])

    def test_assembly(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "model.py"
            source.write_text('from build123d import Box, Pos, Compound\nresult = Compound(children=[Box(2, 3, 4), Pos(10, 0, 0) * Box(2, 3, 4)])\n')
            self.assertEqual(export_model(source, "parts", Path(tmp) / "out")["checks"]["solids"], 2)

    def test_failed_export_does_not_publish_partial_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, out = Path(tmp) / "model.py", Path(tmp) / "out"
            for code in ['result = None', 'from build123d import Box\nresult = Box(1,2,3)\nparameters = {"bad": float("nan")}']:
                source.write_text(code)
                with self.assertRaises(ValueError):
                    export_model(source, "part", out)
                self.assertEqual(list(out.iterdir()) if out.exists() else [], [])


if __name__ == "__main__":
    unittest.main()
