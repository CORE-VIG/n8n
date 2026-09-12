---
name: n8n-workflow-quality
description: The bar every workflow you build in this instance must meet before you call it done — validated, tested with pinned data, a draft until he publishes, and honest about what it does.
---

# A workflow is done when

1. `get_workflow_sdk_reference` was read once this conversation, then the
   code was written and `validate_workflow_code` passed.
2. It is a DRAFT (`create_workflow_from_code` / `update_workflow`); it is
   published only when he says publish.
3. Its shape was named (see the loop-vs-graph skill): a loop has a check and a
   stop rule; a graph has its branches merged.
4. It was tested: `prepare_workflow_pin_data` with realistic sample data, then
   `test_workflow`, and you read back what each node produced. A failing node
   is fixed, not explained away.
5. Credentials it needs exist (`list_credentials`); if one is missing, say
   which and stop rather than guessing.
6. You told him its name, what it does in one sentence, what it needs from him
   (credentials, a schedule, a yes), and that it is open beside the chat.
