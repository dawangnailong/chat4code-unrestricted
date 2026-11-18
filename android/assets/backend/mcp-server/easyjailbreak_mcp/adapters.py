"""EasyJailbreak 的模型适配层。

把任意 OpenAI 兼容接口包成 EasyJailbreak 需要的 ``model.generate(...)`` 语义：
- ``generate(str | list[str], clear_old_history=True, **kwargs) -> str``
- ``batch_generate(list[str] | list[list[str]], **kwargs) -> list[str]``
- ``set_system_message(str)``
- ``conversation``：PAIR / TAP 会读取 system_message、messages、roles 并 deepcopy

不引入 fastchat 依赖，直接实现它用到的那一小部分对话状态。
"""

from __future__ import annotations

from typing import Any


class Conversation:
    """fastchat.conversation.Conversation 的最小兼容实现。"""

    def __init__(self, system_message: str = '') -> None:
        self.system_message = system_message
        self.messages: list[list[str | None]] = []
        self.roles = ('user', 'assistant')

    def append_message(self, role: str, message: str | None) -> None:
        self.messages.append([role, message])

    def to_openai_api_messages(self) -> list[dict[str, str]]:
        result: list[dict[str, str]] = []
        if self.system_message:
            result.append({'role': 'system', 'content': self.system_message})
        for role, message in self.messages:
            if message is None:
                continue
            result.append({'role': role or 'user', 'content': message})
        return result


class _CountedGenerate:
    """可调用对象，顺带记录调用次数（TAP 会读 ``generate.count_calls``）。"""

    def __init__(self, fn) -> None:
        self._fn = fn
        self.calls = 0
        self.count_calls = 0

    def __call__(self, *args: Any, **kwargs: Any) -> str:
        self.calls += 1
        self.count_calls += 1
        return self._fn(*args, **kwargs)


class ChatModel:
    """OpenAI 兼容接口的对话模型。

    默认指向 DeepSeek 的 OpenAI 兼容端点；也可以填本地 Ollama / vLLM 的地址。
    """

    def __init__(
        self,
        model: str,
        base_url: str | None = None,
        api_key: str = 'EMPTY',
        generation_config: dict[str, Any] | None = None,
        timeout: float = 120.0,
    ) -> None:
        from openai import OpenAI

        self.model = model
        self.client = OpenAI(api_key=api_key or 'EMPTY', base_url=base_url, timeout=timeout)
        self.generation_config: dict[str, Any] = dict(generation_config or {})
        self.conversation = Conversation()
        self.generate = _CountedGenerate(self._generate)

    def set_system_message(self, system_message: str) -> None:
        self.conversation.system_message = system_message

    def _generate(
        self,
        messages: str | list[str],
        clear_old_history: bool = True,
        **kwargs: Any,
    ) -> str:
        if clear_old_history:
            self.conversation.messages = []
        if isinstance(messages, str):
            messages = [messages]
        for index, message in enumerate(messages):
            self.conversation.append_message(self.conversation.roles[index % 2], message)

        config = {**self.generation_config, **kwargs}
        config.pop('clear_old_history', None)
        # EasyJailbreak 的 HuggingFace 分支参数不该传给 OpenAI 接口
        for key in ('max_new_tokens', 'eos_token_id', 'do_sample'):
            config.pop(key, None)

        response = self.client.chat.completions.create(
            model=self.model,
            messages=self.conversation.to_openai_api_messages(),
            **config,
        )
        return response.choices[0].message.content or ''

    def batch_generate(
        self,
        conversations: list[str | list[str]],
        **kwargs: Any,
    ) -> list[str]:
        return [self._generate(conversation, **kwargs) for conversation in conversations]


class MockChatModel(ChatModel):
    """不联网的假模型，用于本地联调与自检。"""

    def __init__(self, reply: str = 'I am sorry, but I cannot help with that.', **_: Any) -> None:
        self.model = 'mock'
        self.generation_config = {'max_tokens': 64, 'temperature': 0}
        self.conversation = Conversation()
        self.reply = reply
        self.calls = 0
        self.generate = _CountedGenerate(self._generate)  # type: ignore[assignment]

    def set_system_message(self, system_message: str) -> None:
        self.conversation.system_message = system_message

    def _generate(self, messages: str | list[str], clear_old_history: bool = True, **_: Any) -> str:
        if clear_old_history:
            self.conversation.messages = []
        if isinstance(messages, str):
            messages = [messages]
        for index, message in enumerate(messages):
            self.conversation.append_message(self.conversation.roles[index % 2], message)
        return self.reply
