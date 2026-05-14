import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "chart-versioner"


class ChartVersionerTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmpdir.name)
        self.git("init")
        self.git("config", "user.name", "Test Bot")
        self.git("config", "user.email", "test@example.com")

    def tearDown(self):
        self.tmpdir.cleanup()

    def git(self, *args):
        return subprocess.run(
            ["git", *args],
            cwd=self.repo,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ).stdout.strip()

    def commit_all(self, message):
        self.git("add", ".")
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def chart(self, name, version="0.0.0"):
        chart_dir = self.repo / "charts" / name
        chart_dir.mkdir(parents=True, exist_ok=True)
        (chart_dir / "Chart.yaml").write_text(
            textwrap.dedent(
                f"""\
                apiVersion: v2
                name: {name}
                version: {version}
                """
            ),
            encoding="utf-8",
        )
        return chart_dir

    def run_versioner(self, *args, check=True):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            cwd=self.repo,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if check and result.returncode != 0:
            self.fail(f"chart-versioner failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        return result

    def test_write_bumps_fix_to_patch(self):
        redis = self.chart("redis")
        base = self.commit_all("chore: initial charts")
        (redis / "values.yaml").write_text("enabled: true\n", encoding="utf-8")
        self.commit_all("fix: adjust redis defaults")

        output = self.repo / "plan.json"
        result = self.run_versioner("write", "--base", base, "--head", "HEAD", "--output", str(output))

        self.assertIn("redis", result.stdout)
        self.assertIn("version: 0.0.1", (redis / "Chart.yaml").read_text(encoding="utf-8"))
        plan = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(plan["changed_charts"], ["redis"])
        self.assertEqual(plan["charts"][0]["bump"], "patch")
        self.assertEqual(plan["charts"][0]["next_version"], "0.0.1")

    def test_write_bumps_feat_to_minor_for_each_changed_chart(self):
        redis = self.chart("redis")
        postgresql = self.chart("postgresql")
        base = self.commit_all("chore: initial charts")
        (redis / "values.yaml").write_text("enabled: true\n", encoding="utf-8")
        (postgresql / "values.yaml").write_text("enabled: true\n", encoding="utf-8")
        self.commit_all("feat: add database defaults")

        self.run_versioner("write", "--base", base, "--head", "HEAD")

        self.assertIn("version: 0.1.0", (redis / "Chart.yaml").read_text(encoding="utf-8"))
        self.assertIn("version: 0.1.0", (postgresql / "Chart.yaml").read_text(encoding="utf-8"))

    def test_chart_change_without_release_commit_is_ignored(self):
        redis = self.chart("redis")
        base = self.commit_all("chore: initial charts")
        (redis / "values.yaml").write_text("enabled: true\n", encoding="utf-8")
        self.commit_all("chore: adjust redis defaults")

        result = self.run_versioner("plan", "--base", base, "--head", "HEAD")
        plan = json.loads(result.stdout)

        self.assertEqual(plan["changed_charts"], [])
        self.assertEqual(plan["charts"], [])

    def test_feat_breaking_change_bumps_major(self):
        redis = self.chart("redis")
        base = self.commit_all("chore: initial charts")
        (redis / "values.yaml").write_text("enabled: true\n", encoding="utf-8")
        self.commit_all("feat!: adjust redis defaults")

        self.run_versioner("write", "--base", base, "--head", "HEAD")

        self.assertIn("version: 1.0.0", (redis / "Chart.yaml").read_text(encoding="utf-8"))

    def test_fix_bang_bumps_major(self):
        redis = self.chart("redis")
        base = self.commit_all("chore: initial charts")
        (redis / "values.yaml").write_text("enabled: true\n", encoding="utf-8")
        self.commit_all("fix!: adjust redis defaults")

        self.run_versioner("write", "--base", base, "--head", "HEAD")

        self.assertIn("version: 1.0.0", (redis / "Chart.yaml").read_text(encoding="utf-8"))

    def test_breaking_change_body_without_bang_does_not_bump_major(self):
        redis = self.chart("redis")
        base = self.commit_all("chore: initial charts")
        (redis / "values.yaml").write_text("enabled: true\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-m", "fix: adjust redis defaults", "-m", "BREAKING CHANGE: changes redis defaults")

        self.run_versioner("write", "--base", base, "--head", "HEAD")

        self.assertIn("version: 0.0.1", (redis / "Chart.yaml").read_text(encoding="utf-8"))

    def test_readme_only_change_is_ignored(self):
        redis = self.chart("redis")
        base = self.commit_all("chore: initial charts")
        (redis / "README.md").write_text("# Redis\n", encoding="utf-8")
        self.commit_all("docs: update redis readme")

        result = self.run_versioner("plan", "--base", base, "--head", "HEAD")
        plan = json.loads(result.stdout)

        self.assertEqual(plan["changed_charts"], [])
        self.assertEqual(plan["charts"], [])

    def test_existing_expected_version_is_not_bumped_twice(self):
        redis = self.chart("redis")
        base = self.commit_all("chore: initial charts")
        (redis / "values.yaml").write_text("enabled: true\n", encoding="utf-8")
        (redis / "Chart.yaml").write_text(
            textwrap.dedent(
                """\
                apiVersion: v2
                name: redis
                version: 0.0.1
                """
            ),
            encoding="utf-8",
        )
        self.commit_all("fix: adjust redis defaults")

        self.run_versioner("write", "--base", base, "--head", "HEAD")

        self.assertIn("version: 0.0.1", (redis / "Chart.yaml").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
