import runpy
from pathlib import Path


def test_execution_acceptance_requires_actual_output_and_later_prompt():
    verify = runpy.run_path(str(Path(__file__).resolve().parents[1] / "acceptance/execute-herdr.py"))[
        "output_and_prompt_visible"
    ]
    marker = {"id": "L0004", "text": "BROKER_RESULT\\u000d"}
    prompt = {"id": "L0005", "text": "$ "}
    assert verify({"evidence": [marker, prompt]}, "BROKER_RESULT", "$")
    assert not verify({"evidence": [marker]}, "BROKER_RESULT", "$")
    assert not verify({"evidence": [prompt]}, "BROKER_RESULT", "$")
    assert not verify({"evidence": [{**prompt, "id": "L0003"}, marker]}, "BROKER_RESULT", "$")
    assert not verify({"evidence": [{**marker, "text": "print('BROKER_RESULT')"}, prompt]}, "BROKER_RESULT", "$")
