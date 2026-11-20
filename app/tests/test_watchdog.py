from plughub import watchdog
from plughub.watchdog import Watchdog


class Clock:
    t = 100.0

    def __call__(self):
        return self.t


def test_stall_restarts_and_reports(data_dir):
    clock = Clock()
    notes, exits = [], []
    w = Watchdog(data_dir, lambda t, m: notes.append(t), clock=clock)
    w.exit = exits.append
    w.tick()
    clock.t += watchdog.STALL_S - 1
    assert w.healthy() and not w.check_once()
    clock.t += 2
    assert not w.healthy()
    assert w.check_once()
    assert exits == [3] and notes == ["家庭中控卡住了"]
    # 重新啟動後知道剛剛卡住過，只講一次
    w2 = Watchdog(data_dir, print)
    assert "沒有反應" in w2.after_restart()
    assert w2.after_restart() is None
