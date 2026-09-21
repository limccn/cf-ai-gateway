// Add provider 弹窗（批次 N，2026-09-21）。
//
// **刻意不拆**（PRD 裁决 D13）：新建时用户手上还没有这条 provider，不存在「只想改一个字段、
// 却被其余九个字段的当前值围住」的问题 —— 拆分要解决的正是那个问题。新建只有一个入口，
// 高级项仍收在 Collapsible 里按需展开。
//
// 状态挂载策略：内容只在 `open` 时挂载（与 ProfileDialog / ChangePasswordDialog 同一写法），
// 于是「每次重开都是干净的空表单」由 useState 的惰性初值天然保证，不需要在打开时手工清空。
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible } from "@/components/ui/collapsible";
import { Dialog } from "@/components/ui/dialog";
import { useCreateProvider } from "../hooks/use-create-provider";
import { emptyProviderForm, parseCreateForm } from "../form";
import type { FieldErrors, ProviderFormState } from "../form";
import { FormError, ProviderAdvancedFields, ProviderBasicsFields } from "./provider-fields";

export interface ProviderCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProviderCreateDialog({ open, onOpenChange }: ProviderCreateDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add provider"
      description="Provider keys are encrypted at rest and never shown again."
    >
      {open ? <CreateProviderForm onDone={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function CreateProviderForm({ onDone }: { onDone: () => void }) {
  const createProvider = useCreateProvider();
  const [form, setForm] = useState(emptyProviderForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const patch = (next: Partial<ProviderFormState>) => setForm((prev) => ({ ...prev, ...next }));
  const isBusy = createProvider.isPending;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    const parsed = parseCreateForm(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    try {
      // 新 provider 恒为 enabled（启停由列表 Action 开关管理，创建时不提供 enabled UI）
      await createProvider.mutateAsync({ ...parsed.data, enabled: true });
      onDone();
    } catch {
      // 错误显示在表单顶部
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <FormError message={createProvider.error?.message} />
      <ProviderBasicsFields
        value={form}
        onChange={patch}
        errors={errors}
        apiKeyMode={{ kind: "create" }}
        editing={false}
      />
      <Collapsible title="Advanced options" open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <ProviderAdvancedFields value={form} onChange={patch} errors={errors} />
      </Collapsible>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone} disabled={isBusy}>
          Cancel
        </Button>
        <Button type="submit" disabled={isBusy}>
          {isBusy ? "Saving…" : "Add provider"}
        </Button>
      </div>
    </form>
  );
}
