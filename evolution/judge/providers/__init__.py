"""Built-in judge providers. Importing this package registers them all."""
from ..provider import JudgeRegistry

from .ollama import OllamaProvider
from .llama_cpp import LlamaCppProvider
from .gemini import GeminiProvider
from .mock import MockProvider
from .claude_cli import ClaudeCliJudgeProvider
from .codex_proxy import CodexProxyProvider

_registry = JudgeRegistry.default()
_registry.register(OllamaProvider())
_registry.register(LlamaCppProvider())
_registry.register(GeminiProvider())
_registry.register(MockProvider())
_registry.register(ClaudeCliJudgeProvider())
_registry.register(CodexProxyProvider())

__all__ = [
    "OllamaProvider", "LlamaCppProvider", "GeminiProvider", "MockProvider",
    "ClaudeCliJudgeProvider", "CodexProxyProvider",
]
