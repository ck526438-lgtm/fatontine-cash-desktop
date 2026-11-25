/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./src/**/*.{html,js}'],
    theme: {
        extend: {
            fontFamily: {
                sans: ['"Plus Jakarta Sans"', 'sans-serif']
            },
            colors: {
                navy: {
                    950: '#040B16',
                    900: '#0A192F',
                    800: '#13284A',
                    700: '#1E3A6E'
                },
                gold: {
                    200: '#FBF0C9',
                    300: '#F6E094',
                    400: '#ECCB60',
                    500: '#D4AF37',
                    600: '#B08D22'
                }
            }
        }
    },
    plugins: []
};
