// Preview carousel — auto-rotate + dot click
document.querySelectorAll('.preview-carousel').forEach(carousel => {
    const imgs = carousel.querySelectorAll('.preview-img');
    const dots = carousel.querySelectorAll('.dot');
    let current = 0;
    let interval;

    function show(index) {
        imgs[current].classList.remove('active');
        dots[current].classList.remove('active');
        current = index;
        imgs[current].classList.add('active');
        dots[current].classList.add('active');
    }

    function next() {
        show((current + 1) % imgs.length);
    }

    function startAuto() {
        interval = setInterval(next, 4000);
    }

    dots.forEach((dot, i) => {
        dot.addEventListener('click', () => {
            clearInterval(interval);
            show(i);
            startAuto();
        });
    });

    startAuto();
});
