import { Children, isValidElement, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
const buttonVariants = cva("button", {
  variants: {
    variant: { default: "", primary: "primary", destructive: "danger" },
  },
  defaultVariants: { variant: "default" },
});
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;
export function Button({
  className,
  variant,
  type = "button",
  ...props
}: ButtonProps) {
  const children = Children.toArray(props.children).filter(
    (child) => typeof child !== "string" || child.trim(),
  );
  const child = children[0];
  const iconOnly =
    children.length === 1 &&
    isValidElement(child) &&
    (child.type === "svg" || typeof child.type !== "string");
  return (
    <button
      type={type}
      data-icon-only={iconOnly || undefined}
      aria-label={props["aria-label"] ?? props.title}
      className={twMerge(clsx(buttonVariants({ variant }), className))}
      {...props}
    />
  );
}
