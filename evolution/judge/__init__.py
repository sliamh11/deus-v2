from .base import BaseJudge, JudgeResult
from .provider import JudgeProvider, JudgeRegistry, NoProviderAvailableError

# Legacy exports (backward compat)
from .gemini_judge import GeminiRuntimeJudge
from .ollama_judge import OllamaRuntimeJudge, is_ollama_available
from .llama_cpp_judge import LlamaCppRuntimeJudge, is_llama_cpp_available

# Register built-in providers on import
from . import providers as _providers  # noqa: F401

from typing import Optional


def make_runtime_judge(model: Optional[str] = None, provider: Optional[str] = None) -> BaseJudge:
    """Resolve best provider and return a runtime judge.

    The returned judge carries a `provider_name` attribute (the resolved provider's
    registry name, e.g. "gemini"/"claude"/"codex") so callers can persist which provider
    produced a score (see evolution/ilog/interaction_log.py's update_score `provider`
    param) without re-resolving the registry themselves.
    """
    resolved = JudgeRegistry.default().resolve(provider)
    judge = resolved.make_runtime_judge(model)
    judge.provider_name = resolved.name
    return judge


__all__ = [
    "BaseJudge", "JudgeResult",
    "JudgeProvider", "JudgeRegistry", "NoProviderAvailableError",
    "GeminiRuntimeJudge",
    "OllamaRuntimeJudge", "is_ollama_available",
    "LlamaCppRuntimeJudge", "is_llama_cpp_available",
    "make_runtime_judge",
]
