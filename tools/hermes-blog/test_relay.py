import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("relay", Path(__file__).with_name("relay.py"))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

ARTICLE = {"title": "A clear enquiry", "slug": "a-clear-enquiry", "authorName": "Diversity Technology Limited",
           "format": "markdown", "body": "## Prepare\n\nTell the factory what you need."}


class KB:
    def __init__(self):
        self.documents = {}
        self.adds = 0
        self.lose_next_reply = False

    def call(self, name, args):
        if name == "list_documents":
            rows = [x for x in self.documents.values() if args["tag"] in x.get("tags", []) and x["workspace_id"] == int(args["workspace"])]
            return {"total": len(rows), "documents": rows}
        if name == "get_document":
            return copy.deepcopy(self.documents[args["document_id"]])
        if name == "add_document":
            self.adds += 1
            row = {"id": self.adds, "title": args["title"], "content": args["content"],
                   "workspace_id": int(args["workspace"]), "tags": args["tags"]}
            self.documents[row["id"]] = row
            if self.lose_next_reply:
                self.lose_next_reply = False
                raise TimeoutError("committed, reply lost")
            return copy.deepcopy(row)
        raise AssertionError(name)


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.kb = KB()

    def test_workspace_two_and_replays_reuse_one_document(self):
        first = relay.save_source(self.kb, ARTICLE)
        self.assertEqual(relay.save_source(self.kb, ARTICLE), first)
        self.assertEqual(self.kb.adds, 1)
        self.assertEqual(self.kb.documents[first]["workspace_id"], 2)
        changed = {**ARTICLE, "body": "different text"}
        with self.assertRaises(ValueError):
            relay.save_source(self.kb, changed)
        self.assertEqual(self.kb.adds, 1)
        second = relay.save_source(self.kb, {**ARTICLE, "slug": "another-article", "title": "Another article"})
        self.assertNotEqual(first, second)

    def test_string_body_survives_mcp_eager_json_argument_parsing(self):
        class JsonParsingKB(KB):
            def call(self, name, args):
                if name == "add_document":
                    try:
                        decoded = json.loads(args["content"])
                    except ValueError:
                        decoded = args["content"]
                    if not isinstance(decoded, str):
                        raise ValueError("MCP converted JSON text into an object")
                return super().call(name, args)
        kb = JsonParsingKB()
        ident = relay.save_source(kb, ARTICLE)
        self.assertEqual(relay.parse_document(kb.documents[ident]), ARTICLE)
        self.assertEqual(relay.save_source(kb, ARTICLE), ident)
        self.assertEqual(kb.adds, 1)

    def test_a_lost_kb_commit_reply_is_recovered_by_stable_source_tag(self):
        self.kb.lose_next_reply = True
        with self.assertRaises(TimeoutError):
            relay.save_source(self.kb, ARTICLE)
        self.assertEqual(relay.save_source(self.kb, ARTICLE), 1)
        self.assertEqual(self.kb.adds, 1)

    def test_unconfirmed_source_listing_never_creates_a_document(self):
        for value in ({}, {"total": 1, "documents": []}, {"total": True, "documents": []}):
            class BrokenKB:
                def call(self, name, args):
                    if name == "list_documents":
                        return value
                    raise AssertionError("must not write after an invalid source listing")
            with self.assertRaises(ValueError):
                relay.save_source(BrokenKB(), ARTICLE)

    def test_wrong_workspace_and_mismatching_document_identity_never_handoff(self):
        self.kb.documents[201] = {"id": 201, "title": ARTICLE["title"], "workspace_id": 1, "content": "irrelevant"}
        config = {"siteId": relay.SITE, "workspaceId": 2, "role": "content"}
        with self.assertRaises(ValueError):
            relay.invoke(config, "submit", {"documentId": 201}, kb=self.kb,
                         execute=lambda *args: self.fail("must not hand off"))
        self.kb.documents[201]["id"] = 202
        with self.assertRaises(ValueError):
            relay.fetch_document(self.kb, 201)

    def test_failed_remote_handoff_returns_the_persisted_id_for_retry(self):
        config = {"siteId": relay.SITE, "workspaceId": 2, "role": "content", "sshConfig": "/private/ssh", "sshHost": "publisher"}
        def unavailable(*args):
            raise ValueError("remote result lost")
        result = relay.invoke(config, "save", {"article": ARTICLE}, kb=self.kb, execute=unavailable)
        self.assertFalse(result["ok"])
        self.assertEqual(result["documentId"], 1)
        self.assertEqual(self.kb.adds, 1)
        identity = "article-" + "a" * 64
        result = relay.invoke(config, "submit", {"documentId": 1}, kb=self.kb,
                              execute=lambda *args: {"state": "ready", "articleId": identity,
                                                     "editUrl": "https://supplychainsai.com/admin/?section=articles&article=" + identity})
        self.assertEqual(result["articleId"], identity)
        self.assertEqual(self.kb.adds, 1)

    def test_existing_markdown_metadata_is_parsed_without_body_rewriting(self):
        body = "## Prepare\n\nKeep this exact text.\n"
        doc = {"id": 201, "workspace_id": 2, "title": "A clear enquiry", "content":
               "# A clear enquiry\n\nSEO title: Clear enquiry\nIntro: Short introduction\nAuthor: Diversity Technology Limited\nSlug: a-clear-enquiry\n\n" + body}
        self.assertEqual(relay.parse_document(doc)["body"], body)
        doc["content"] = doc["content"].replace("Intro:", "Unknown metadata:")
        with self.assertRaises(ValueError):
            relay.parse_document(doc)

    def test_private_configuration_and_strict_task_bounds(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"binding.json"
            path.write_text("{}")
            path.chmod(0o600)
            self.assertEqual(relay.private_json(path), {})
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                relay.private_json(path)
        for value in (True, 0, -1, "201", 1.2, 9007199254740992):
            with self.assertRaises(ValueError):
                relay.document_id(value)
        with self.assertRaises(ValueError):
            relay.validate_article({**ARTICLE, "credential": "not permitted"})
        with self.assertRaises(ValueError):
            relay.invoke({"siteId": relay.SITE, "workspaceId": 3, "role": "publisher"}, "submit", {"documentId": 1})


if __name__ == "__main__":
    unittest.main()
