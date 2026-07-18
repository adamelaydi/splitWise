    "use client";

    import Link from "next/link";
    import { useState } from "react";
    import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
    import { faBars, faXmark } from "@fortawesome/free-solid-svg-icons";
    import { cn } from "@/lib/utils";

    export default function Header() {
    const [open, setOpen] = useState(false);

    return (
        <header className="container mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        {/* Logo */}
        <Link href="/" className="text-2xl font-bold text-teal-600">
            Split Wise
        </Link>

        {/* Desktop Navigation */}
        <nav className="hidden sm:block">
            <ul className="flex items-center gap-8">
            <li className="font-semibold capitalize cursor-pointer hover:text-teal-600">
                Product
            </li>
            <li className="font-semibold capitalize cursor-pointer hover:text-teal-600">
                Integration
            </li>
            <li className="font-semibold capitalize cursor-pointer hover:text-teal-600">
                Pricing
            </li>
            <li className="font-semibold capitalize cursor-pointer hover:text-teal-600">
                Enterprise
            </li>
            </ul>
        </nav>

        {/* Mobile Menu Button */}
        <button
            className="sm:hidden text-xl"
            onClick={() => setOpen((prev) => !prev)}
        >
            <FontAwesomeIcon icon={open ? faXmark : faBars} />
        </button>

        {/* Mobile Menu */}
        <ul
            className={cn(
            "absolute right-5 top-16 flex w-48 flex-col gap-4 rounded-lg bg-white p-4 shadow-lg sm:hidden",
            open ? "flex" : "hidden"
            )}
        >
            <li className="font-semibold capitalize cursor-pointer hover:text-teal-600">
            Product
            </li>
            <li className="font-semibold capitalize cursor-pointer hover:text-teal-600">
            Integration
            </li>
            <li className="font-semibold capitalize cursor-pointer hover:text-teal-600">
            Pricing
            </li>
            <li className="font-semibold capitalize cursor-pointer hover:text-teal-600">
            Enterprise
            </li>
        </ul>
        </header>
    );
    }