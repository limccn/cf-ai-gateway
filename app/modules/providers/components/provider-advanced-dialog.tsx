// Edit provider — advanced 弹窗（批次 N，2026-09-21；PRD N1）。
//
// 只管原先收在 Collapsible 里的五个字段：httpOptions / weight / thinkingMode /
// reasoningRoundtrip / upstreamTimeoutMs。基础信息在 provider-basics-dialog.tsx。
//
// 为什么这里**没有** Collapsible：用户点 SlidersHorizontal 图标进来，本身就是「我要看高级项」
// 这个意图的表达 —— 再让他展开一次是多余的。Collapsible 只保留在 Add provider（不拆）里，
// 那里它承担的是「新建时默认不吓人」。
//
// 与 basics 的对称约束：本弹窗提交的 payload 里不含 name/type/baseUrl/apiKey/models，
// basics 弹窗提交的 payload 里不含这五个。两个 schema 各自 define，不共用「全字段」schema，
// 这样「我只想改 weight」在结构上就不可能顺手把别的字段一起写回去。
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useUpdateProvider } from "../hooks/use-update-provider";
import { parseAdvancedUpdate, providerToForm } from "../form";
import type { FieldErrors, ProviderFormState } from "../form";
import type { ProviderResponse } from "../types";
import { FormError, ProviderAdvancedFields } from "./provider-fields";

export interface ProviderAdvancedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderResponse | null;
}

export function ProviderAdvancedDialog({
  open,
  onOpenChange,
  provider,
}: ProviderAdvancedDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={provider ? `Edit advanced — ${provider.name}` : "Edit advanced"}
      description="HTTP overrides, load-balancing weight, reasoning mapping and upstream timeout."
    >
      {open && provider ? (
        <EditAdvancedForm provider={provider} onDone={() => onOpenChange(false)} />
      ) : null}
    </Dialog>
  );
}

function EditAdvancedForm({ provider, onDone }: { provider: ProviderResponse; onDone: () => void }) {
  const updateProvider = useUpdateProvider();
  const [form, setForm] = useState<ProviderFormState>(() => providerToForm(provider));
  const [errors, setErrors] = useState<FieldErrors>({});

  const patch = (next: Partial<ProviderFormState>) => setForm((prev) => ({ ...prev, ...next }));
  const isBusy = updateProvider.isPending;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    // 「httpOptions 留空 = 保持原配置」的省略逻辑在 parseAdvancedUpdate 里（纯函数，可单测）
    const parsed = parseAdvancedUpdate(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    try {
      await updateProvider.mutateAsync({ id: provider.id, ...parsed.data });
      onDone();
    } catch {
      // 错误显示在表单顶部
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <FormError message={updateProvider.error?.message} />
      <ProviderAdvancedFields value={form} onChange={patch} errors={errors} />
      {errors.root ? <p className="text-xs text-destructive">{errors.root}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone} disabled={isBusy}>
          Cancel
        </Button>
        <Button type="submit" disabled={isBusy}>
          {isBusy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
