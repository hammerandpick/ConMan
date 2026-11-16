"use strict";

const themes = {
    basic: {
        name: "Basic",
        css: "./css/theme-basic/styles.css",
    },
    medieval: {
        name: "Medieval",
        css: "./css/theme-medieval/styles.css",
    },
    superhero: {
        name: "Superhero",
        css: "./css/theme-superhero/styles.css",
    }
}

function setTheme(theme) {
    if (!themes[theme]) {
        console.warn(`Theme "${theme}" not found. Falling back to "basic".`);
        theme = "basic";
    }
    localStorage.setItem("theme", theme);
    document.getElementById("theme-link").href = themes[theme].css;
}

function initTheme() {
    const datalist = document.getElementById("themes");
    datalist.innerHTML = ""; // Clear existing options
    for (const theme in themes) {
        datalist.appendChild(new Option(themes[theme].name, theme));
    }
    const savedTheme = localStorage.getItem("theme") || "basic";
    document.getElementById("theme-input").value = savedTheme;
    return savedTheme;
}