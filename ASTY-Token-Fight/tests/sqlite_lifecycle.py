"""Offline integration checks for the D1 SQLite schema and its state transitions.
Run: python3 -m unittest discover -s tests -p 'sqlite_*.py' -v
"""
import pathlib
import sqlite3
import unittest

SCHEMA = pathlib.Path(__file__).resolve().parents[1].joinpath('schema.sql').read_text()
MINTS = ['A' * 32, 'B' * 32, 'C' * 32, 'D' * 32]

class FightLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript(SCHEMA)
        for mint in MINTS:
            self.db.execute('INSERT INTO projects VALUES(?, ?, ?, NULL, 100)', (mint, mint[:3], mint[:3]))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def fight(self, fid, a, b):
        self.db.execute("INSERT INTO fights(id,mint_a,mint_b,creator_id,status,created_at) VALUES(?,?,?,?, 'pending',100)", (fid, a, b, 'owner'))
        self.db.commit()

    def accept(self, fid):
        # Matches v0.2's transactional worker D1.batch sequence.
        with self.db:
            self.db.execute("INSERT INTO active_token_locks(mint,fight_id) SELECT mint_a,id FROM fights WHERE id=? AND status='pending'", (fid,))
            self.db.execute("INSERT INTO active_token_locks(mint,fight_id) SELECT mint_b,id FROM fights WHERE id=? AND status='pending'", (fid,))
            self.db.execute("UPDATE fights SET status='active',started_at=100,ends_at=86500 WHERE id=? AND status='pending'", (fid,))

    def finish(self,fid):
        with self.db:
            self.db.execute("UPDATE fights SET status='ended',archived_at=86500,final_votes_a=3,final_votes_b=2,final_score_a=55,final_score_b=45,winner='a' WHERE id=? AND status='active'", (fid,))
            self.db.execute("DELETE FROM active_token_locks WHERE fight_id=? AND EXISTS(SELECT 1 FROM fights WHERE id=? AND status IN ('ended','unresolved'))", (fid,fid))

    def test_independent_parallel_fights(self):
        self.fight('fight1', MINTS[0], MINTS[1]); self.fight('fight2', MINTS[2], MINTS[3])
        self.accept('fight1'); self.accept('fight2')
        self.assertEqual(self.db.execute('SELECT count(*) FROM fights WHERE status="active"').fetchone()[0], 2)
        self.assertEqual(self.db.execute('SELECT count(*) FROM active_token_locks').fetchone()[0], 4)

    def test_cannot_same_pair_pending_reverse_order(self):
        self.fight('fight1', MINTS[0], MINTS[1])
        with self.assertRaises(sqlite3.IntegrityError):
            self.fight('fight2', MINTS[1], MINTS[0])

    def test_lock_on_one_token_is_atomic(self):
        self.fight('fight1', MINTS[0], MINTS[1]); self.accept('fight1')
        self.fight('fight2', MINTS[2], MINTS[1])
        with self.assertRaises(sqlite3.IntegrityError):
            self.accept('fight2')
        self.assertEqual(self.db.execute('SELECT count(*) FROM active_token_locks WHERE fight_id="fight2"').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT status FROM fights WHERE id="fight2"').fetchone()[0], 'pending')

    def test_rematch_after_finished(self):
        self.fight('fight1', MINTS[0], MINTS[1]); self.accept('fight1'); self.finish('fight1')
        self.fight('rematch', MINTS[1], MINTS[0]); self.accept('rematch')
        self.assertEqual(self.db.execute('SELECT status FROM fights WHERE id="fight1"').fetchone()[0], 'ended')
        self.assertEqual(self.db.execute('SELECT count(*) FROM active_token_locks WHERE fight_id="rematch"').fetchone()[0], 2)

    def test_final_votes_survive_private_vote_cleanup(self):
        self.fight('fight1', MINTS[0], MINTS[1]); self.accept('fight1')
        self.db.execute("INSERT INTO votes VALUES('fight1','user1','a',100)")
        self.finish('fight1')
        self.db.execute("DELETE FROM votes WHERE fight_id IN (SELECT id FROM fights WHERE status IN ('ended','unresolved') AND archived_at<?)", (86501,))
        self.assertEqual(self.db.execute('SELECT count(*) FROM votes').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT final_votes_a, final_votes_b, final_score_a FROM fights WHERE id="fight1"').fetchone(), (3, 2, 55))

    def test_expired_challenge_allows_again(self):
        self.fight('old', MINTS[0], MINTS[1])
        self.db.execute("UPDATE fights SET status='expired' WHERE id='old'")
        self.fight('new', MINTS[0], MINTS[1])
        self.assertEqual(self.db.execute("SELECT count(*) FROM fights WHERE status='pending'").fetchone()[0], 1)

if __name__ == '__main__':
    unittest.main()
